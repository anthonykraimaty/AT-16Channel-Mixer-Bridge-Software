# Presses a button of the running MixerBridge.exe window by its text, or lists
# the buttons. Works on dialogs too (the one in front is the enabled one).
#   pwsh tools/gui-click.ps1 -Text "Restart"
#   pwsh tools/gui-click.ps1 -List
param([string]$Text, [switch]$List)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Win {
  public delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Each f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, Each f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Text(IntPtr h) { StringBuilder s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static List<IntPtr> Tops(uint pid) { List<IntPtr> r = new List<IntPtr>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static List<IntPtr> Kids(IntPtr top) { List<IntPtr> r = new List<IntPtr>(); EnumChildWindows(top, (h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
}
"@
$proc = Get-Process MixerBridge -ErrorAction Stop | Select-Object -First 1
foreach ($top in [Win]::Tops([uint32]$proc.Id)) {
  $enabled = [Win]::IsWindowEnabled($top)
  foreach ($kid in [Win]::Kids($top)) {
    $t = [Win]::Text($kid)
    if ($List) { "{0} [{1}] '{2}' enabled={3}" -f $top, [Win]::Text($top), $t, ($enabled -and [Win]::IsWindowEnabled($kid)); continue }
    if ($t -eq $Text -and $enabled -and [Win]::IsWindowEnabled($kid)) {
      $at = [IntPtr](5 -bor (5 -shl 16))
      [void][Win]::PostMessage($kid, 0x201, [IntPtr]1, $at)
      Start-Sleep -Milliseconds 80
      [void][Win]::PostMessage($kid, 0x202, [IntPtr]0, $at)
      "clicked '$t'"; exit 0
    }
  }
}
if (-not $List) { "no enabled button '$Text'"; exit 1 }
