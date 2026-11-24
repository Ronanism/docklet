const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

function runPowerShell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: 6000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message, stdout: stdout || '' });
        resolve({ ok: true, stdout: (stdout || '').trim() });
      }
    );
  });
}

// 枚举当前桌面所有可见顶层窗口 + 前台窗口句柄
async function listVisibleWindows() {
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$fg = [WinEnum]::GetForegroundWindow()
$procs = @{}
Get-Process | ForEach-Object { $procs[[uint32]$_.Id] = $_.ProcessName }
$list = New-Object System.Collections.ArrayList
$cb = [WinEnum+EnumWindowsProc]{
  param($hWnd, $lParam)
  if ([WinEnum]::IsWindowVisible($hWnd)) {
    $len = [WinEnum]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][WinEnum]::GetWindowText($hWnd, $sb, $sb.Capacity)
      $pidOut = [uint32]0
      [void][WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$pidOut)
      $pname = if ($procs.ContainsKey($pidOut)) { $procs[$pidOut] } else { "" }
      [void]$list.Add([PSCustomObject]@{
        hwnd = $hWnd.ToInt64()
        pid = $pidOut
        processName = $pname
        title = $sb.ToString()
        isForeground = ($hWnd -eq $fg)
      })
    }
  }
  return $true
}
[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)
$list | ConvertTo-Json -Compress
`;
  const res = await runPowerShell(ps);
  if (!res.ok || !res.stdout) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// 将指定句柄窗口置前唤醒（兼容最小化窗口与 Windows 前台锁）
async function focusWindowByHwnd(hwnd) {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$h = [IntPtr]::new(${Number(hwnd)})
if ([WinFocus]::IsIconic($h)) {
  [void][WinFocus]::ShowWindowAsync($h, 9)
}
# 发送极轻 Alt 释放以绕过 Windows SetForegroundWindow 焦点限制
[WinFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][WinFocus]::SetForegroundWindow($h)
`;
  await runPowerShell(ps);
}

function matchWindowForItem(item, windows) {
  const hints = [];
  if (Array.isArray(item.processHints)) {
    hints.push(...item.processHints.map((s) => String(s).toLowerCase().trim()).filter(Boolean));
  }
  if (item.target && !/^https?:\/\//i.test(item.target)) {
    const base = path.basename(item.target, path.extname(item.target)).toLowerCase();
    if (base) hints.push(base);
  }
  if (item.name) hints.push(item.name.toLowerCase());

  const uniqueHints = [...new Set(hints)];
  // 排除 Docklet 自身窗口
  const candidates = windows.filter(
    (w) =>
      w.processName &&
      w.processName.toLowerCase() !== 'electron' &&
      !String(w.title || '').includes('Docklet')
  );

  // 优先精确/前缀匹配进程名
  for (const h of uniqueHints) {
    const hit = candidates.find((w) => w.processName.toLowerCase() === h || w.processName.toLowerCase().includes(h));
    if (hit) return hit;
  }
  // 其次匹配窗口标题
  for (const h of uniqueHints) {
    const hit = candidates.find((w) => (w.title || '').toLowerCase().includes(h));
    if (hit) return hit;
  }
  return null;
}

// 智能切换：已打开则置前，未打开则启动
async function focusOrLaunch(item) {
  const windows = await listVisibleWindows();
  const matched = matchWindowForItem(item, windows);
  if (matched) {
    await focusWindowByHwnd(matched.hwnd);
    return { action: 'focused', title: matched.title, processName: matched.processName };
  }

  // 未运行 -> 启动目标
  const target = (item.target || '').trim();
  if (!target) {
    return { action: 'missing_target', message: `未配置 ${item.name} 的程序路径，请点左下角「自动扫描」或拖入快捷方式` };
  }

  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target);
    return { action: 'launched_url', target };
  }

  // 支持 Windows Store / MSIX 应用（shell:AppsFolder\...）
  if (/^shell:/i.test(target)) {
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    return { action: 'launched', target };
  }

  if (fs.existsSync(target)) {
    const err = await shell.openPath(target);
    if (err) {
      spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    }
    return { action: 'launched', target };
  }

  // 尝试作为命令行命令执行
  try {
    spawn('cmd.exe', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { action: 'launched_cmd', target };
  } catch (e) {
    return { action: 'error', message: e.message };
  }
}

// 自动扫描 Windows 开始菜单、桌面、LocalAppData、Program Files 查找软件路径
async function autoDiscoverPaths(items) {
  const need = items.filter((it) => !it.target || (!/^https?:\/\//i.test(it.target) && !fs.existsSync(it.target)));
  if (need.length === 0) return {};

  const keywords = {};
  for (const it of need) {
    keywords[it.id] = [
      ...(it.processHints || []),
      it.name.toLowerCase(),
      it.id.toLowerCase()
    ].filter(Boolean);
  }

  const ps = `
$roots = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:USERPROFILE\\Desktop",
  "$env:LOCALAPPDATA\\Programs",
  "$env:LOCALAPPDATA",
  "C:\\Program Files",
  "C:\\Program Files (x86)"
)
$found = @{}
$specs = ConvertFrom-Json '${JSON.stringify(keywords).replace(/'/g, "''")}'
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $files = Get-ChildItem -Path $root -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Where-Object { -not $_.PSIsContainer -and ($_.Extension -eq '.exe' -or $_.Extension -eq '.lnk') -and $_.Name -notmatch 'unins|update|helper|crash' }
  foreach ($f in $files) {
    $lower = $f.BaseName.ToLower()
    foreach ($prop in $specs.PSObject.Properties) {
      if ($found.ContainsKey($prop.Name)) { continue }
      foreach ($kw in $prop.Value) {
        if ($lower -eq $kw -or $lower -like "*$kw*") {
          $found[$prop.Name] = $f.FullName
          break
        }
      }
    }
  }
}
$found | ConvertTo-Json -Compress
`;
  const res = await runPowerShell(ps);
  if (!res.ok || !res.stdout) return {};
  try {
    return JSON.parse(res.stdout) || {};
  } catch {
    return {};
  }
}

// 批量提取 Windows 真实高清图标（支持 .exe / .ico / .lnk），返回 { id: "data:image/png;base64,..." }
async function extractRealIcons(items) {
  const targets = [];
  for (const it of items) {
    const src = (it.iconPath || '').trim() || (it.target || '').trim();
    if (src && !/^https?:\/\//i.test(src)) {
      targets.push({ id: it.id, path: src, fallback: (it.target || '').trim() });
    }
  }
  if (targets.length === 0) return {};

  const jsonArg = JSON.stringify(targets).replace(/'/g, "''");
  const ps = `
Add-Type -AssemblyName System.Drawing
$items = ConvertFrom-Json '${jsonArg}'
$out = @{}
foreach ($it in $items) {
  $p = $it.path
  if (-not (Test-Path $p) -and $it.fallback -and (Test-Path $it.fallback)) { $p = $it.fallback }
  if (-not (Test-Path $p)) { continue }
  try {
    $ext = [System.IO.Path]::GetExtension($p).ToLower()
    $icon = $null
    if ($ext -eq '.ico') {
      $icon = New-Object System.Drawing.Icon($p, 48, 48)
    } else {
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
    }
    if ($icon -ne $null) {
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      $out[$it.id] = "data:image/png;base64,$b64"
      $ms.Dispose()
      $bmp.Dispose()
      $icon.Dispose()
    }
  } catch {}
}
$out | ConvertTo-Json -Compress
`;
  const res = await runPowerShell(ps);
  if (!res.ok || !res.stdout) return {};
  try {
    return JSON.parse(res.stdout) || {};
  } catch {
    return {};
  }
}

module.exports = {
  listVisibleWindows,
  matchWindowForItem,
  focusOrLaunch,
  autoDiscoverPaths,
  extractRealIcons
};
