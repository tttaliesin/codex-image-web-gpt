using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo(Path.Combine(directory, "runtime", "WebImageBridge.exe"));
            start.WorkingDirectory = directory;
            start.UseShellExecute = false;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            Process.Start(start);
            return 0;
        }
        catch
        {
            MessageBox.Show(
                "앱을 시작하지 못했습니다. ZIP 파일을 모두 압축 해제한 뒤 다시 실행해 주세요.",
                "Web Image Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
