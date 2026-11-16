// GeoStrands launcher: opens GeoStrands.html (next to this exe) in a chromeless
// app window using Edge or Chrome, falling back to the default browser.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string html = Path.Combine(dir, "GeoStrands.html");
        if (!File.Exists(html))
        {
            MessageBox.Show("GeoStrands.html was not found next to GeoStrands.exe.\nKeep both files in the same folder.", "GeoStrands", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        string url = new Uri(html).AbsoluteUri;
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] browsers = {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string b in browsers)
        {
            if (!File.Exists(b)) continue;
            // Separate profile dir keeps GeoStrands' window, autosave and settings apart from normal browsing.
            string profile = Path.Combine(local, "GeoStrands", "profile");
            Process.Start(b, "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --window-size=1440,900");
            return;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
