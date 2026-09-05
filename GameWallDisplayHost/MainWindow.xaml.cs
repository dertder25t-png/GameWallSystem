using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace GameWallDisplayHost;

public partial class MainWindow : Window
{
    private const int ListenPort = 5000;

    // Sample public test-clip URLs used by "test mode" so you can check
    // the grid/layout before kickoff without needing real game links.
    private static readonly string[] TestUrls =
    {
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
        "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
    };

    private WebView2[] _slots = Array.Empty<WebView2>();
    private Border[] _borders = Array.Empty<Border>();
    private CoreWebView2Environment? _environment;
    private CommandServer? _server;
    private LayoutDefinition _currentLayout = Layouts.FourUp;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
        KeyDown += MainWindow_KeyDown;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        _slots = new[] { Slot0, Slot1, Slot2, Slot3, Slot4, Slot5, Slot6, Slot7 };
        _borders = new[] { Border0, Border1, Border2, Border3, Border4, Border5, Border6, Border7 };

        await InitializeWebViewsAsync();
        ApplyLayout(_currentLayout);

        _server = new CommandServer(ListenPort);
        _server.CommandReceived += OnCommandReceived;
        _server.Start();

        StatusText.Text = $"Listening: {GetLocalIPv4()}:{ListenPort}";
    }

    /// <summary>
    /// All 8 WebView2 controls share one CoreWebView2Environment pointed at
    /// a fixed user-data folder, so cookies/sessions (i.e. your Hulu login)
    /// persist across every slot and across app restarts.
    /// </summary>
    private async Task InitializeWebViewsAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "GameWallDisplayHost", "WebView2Profile");
        Directory.CreateDirectory(userDataFolder);

        _environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);

        foreach (var slot in _slots)
        {
            await slot.EnsureCoreWebView2Async(_environment);
            slot.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            slot.CoreWebView2.Settings.AreDevToolsEnabled = false;
            slot.CoreWebView2.Navigate("about:blank");
        }
    }

    /// <summary>Arranges the grid rows/cols and per-slot placement for the given layout.</summary>
    private void ApplyLayout(LayoutDefinition layout)
    {
        _currentLayout = layout;
        SlotGrid.RowDefinitions.Clear();
        SlotGrid.ColumnDefinitions.Clear();

        for (int r = 0; r < layout.Rows; r++)
            SlotGrid.RowDefinitions.Add(new RowDefinition());
        for (int c = 0; c < layout.Cols; c++)
            SlotGrid.ColumnDefinitions.Add(new ColumnDefinition());

        for (int i = 0; i < _borders.Length; i++)
        {
            if (i < layout.VisibleCount)
            {
                var p = layout.Placements[i];
                _borders[i].Visibility = Visibility.Visible;
                Grid.SetRow(_borders[i], p.Row);
                Grid.SetColumn(_borders[i], p.Col);
                Grid.SetRowSpan(_borders[i], p.RowSpan);
                Grid.SetColumnSpan(_borders[i], p.ColSpan);
            }
            else
            {
                _borders[i].Visibility = Visibility.Collapsed;
            }
        }
    }

    private void OnCommandReceived(SlotCommand cmd)
    {
        // WebView2/UI must be touched from the UI thread.
        Dispatcher.Invoke(() =>
        {
            switch (cmd.Action)
            {
                case "navigate":
                    if (cmd.Slot is int ns && ns is >= 0 and < 8 && cmd.Url is not null)
                        _slots[ns].CoreWebView2?.Navigate(cmd.Url);
                    break;

                case "mute":
                    if (cmd.Slot is int ms && ms is >= 0 and < 8 && cmd.Muted is bool muted)
                        SetMute(ms, muted);
                    break;

                case "volume":
                    if (cmd.Slot is int vs && vs is >= 0 and < 8 && cmd.Volume is double vol)
                        _ = SetVolumeAsync(vs, Math.Clamp(vol, 0.0, 1.0));
                    break;

                case "close":
                    if (cmd.Slot is int cs && cs is >= 0 and < 8)
                        _slots[cs].CoreWebView2?.Navigate("about:blank");
                    break;

                case "closeAll":
                    foreach (var s in _slots) s.CoreWebView2?.Navigate("about:blank");
                    break;

                case "layout":
                    if (cmd.Layout is not null)
                        ApplyLayout(Layouts.ByName(cmd.Layout));
                    break;

                case "test":
                    RunTestMode();
                    break;
            }
        });
    }

    private void SetMute(int slotIndex, bool muted)
    {
        var core = _slots[slotIndex].CoreWebView2;
        if (core is not null) core.IsMuted = muted;
    }

    private async Task SetVolumeAsync(int slotIndex, double volume)
    {
        var core = _slots[slotIndex].CoreWebView2;
        if (core is null) return;
        // WebView2 doesn't expose a per-control volume API beyond mute,
        // so we set it on the underlying <video>/<audio> elements directly.
        string script = $"document.querySelectorAll('video,audio').forEach(function(m){{ m.volume = {volume.ToString(System.Globalization.CultureInfo.InvariantCulture)}; }});";
        await core.ExecuteScriptAsync(script);
    }

    private void RunTestMode()
    {
        ApplyLayout(Layouts.EightUp);
        for (int i = 0; i < TestUrls.Length; i++)
            _slots[i].CoreWebView2?.Navigate(TestUrls[i]);
    }

    private void MainWindow_KeyDown(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.F5:
                RunTestMode();
                break;
            case Key.Escape:
                Close();
                break;
            case Key.F11:
                StatusOverlay.Visibility = StatusOverlay.Visibility == Visibility.Visible
                    ? Visibility.Collapsed
                    : Visibility.Visible;
                break;
        }
    }

    private static string GetLocalIPv4()
    {
        foreach (var ip in Dns.GetHostAddresses(Dns.GetHostName()))
        {
            if (ip.AddressFamily == AddressFamily.InterNetwork)
                return ip.ToString();
        }
        return "127.0.0.1";
    }

    protected override void OnClosed(EventArgs e)
    {
        _server?.Stop();
        base.OnClosed(e);
    }
}
