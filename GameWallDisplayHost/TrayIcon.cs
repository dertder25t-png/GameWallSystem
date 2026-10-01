using WinForms = System.Windows.Forms;

namespace GameWallDisplayHost;

/// <summary>
/// The tray icon: GameWall lives here when no game session is running.
/// Everything on the menu runs on the WPF UI thread via the callbacks passed in.
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private readonly WinForms.NotifyIcon _icon;
    private readonly WinForms.ToolStripMenuItem _status;
    private readonly WinForms.ToolStripMenuItem _startWithWindows;
    private readonly WinForms.ToolStripMenuItem _lanRemote;

    public TrayIcon(
        Action showWall,
        Action endSession,
        Action pairPhone,
        Action showPairedPhones,
        Action forgetPhones,
        Action<bool> setLanRemote,
        bool lanRemoteEnabled,
        Action quit)
    {
        _status = new WinForms.ToolStripMenuItem("Starting…") { Enabled = false };
        _startWithWindows = new WinForms.ToolStripMenuItem("Start with Windows")
        {
            CheckOnClick = true,
            Checked = StartupManager.IsEnabled,
        };
        _startWithWindows.CheckedChanged += (_, _) => StartupManager.SetEnabled(_startWithWindows.Checked);

        _lanRemote = new WinForms.ToolStripMenuItem("Allow Wi-Fi remote (port 5000, less secure)")
        {
            CheckOnClick = true,
            Checked = lanRemoteEnabled,
        };
        _lanRemote.CheckedChanged += (_, _) => setLanRemote(_lanRemote.Checked);

        var menu = new WinForms.ContextMenuStrip();
        menu.Items.Add(_status);
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Show the wall", null, (_, _) => showWall());
        menu.Items.Add("End session (hide the wall)", null, (_, _) => endSession());
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Pair a phone…", null, (_, _) => pairPhone());
        menu.Items.Add("Check phone link…", null, (_, _) => showPairedPhones());
        menu.Items.Add("Forget all phones", null, (_, _) => forgetPhones());
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add(_startWithWindows);
        menu.Items.Add(_lanRemote);
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Quit GameWall", null, (_, _) => quit());

        _icon = new WinForms.NotifyIcon
        {
            Icon = LoadIcon(),
            Text = "GameWall",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _icon.DoubleClick += (_, _) => showWall();
    }

    private static System.Drawing.Icon LoadIcon()
    {
        try
        {
            if (Environment.ProcessPath is { } path)
                return System.Drawing.Icon.ExtractAssociatedIcon(path) ?? System.Drawing.SystemIcons.Application;
        }
        catch { }
        return System.Drawing.SystemIcons.Application;
    }

    public void SetStatus(string text)
    {
        _status.Text = text;
        var tip = $"GameWall · {text}";
        _icon.Text = tip.Length > 63 ? tip[..63] : tip;
    }

    public void Notify(string title, string text) =>
        _icon.ShowBalloonTip(4000, title, text, WinForms.ToolTipIcon.None);

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
    }
}
