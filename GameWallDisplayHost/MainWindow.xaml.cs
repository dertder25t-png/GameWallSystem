using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Windows;
using FormsScreen = System.Windows.Forms.Screen;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
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
    private int _selectedMonitorIndex;
    private readonly string?[] _lastUrls = new string?[8];
    private readonly System.Windows.Threading.DispatcherTimer _watchdogTimer = new();
    private readonly int[] _stallFailures = new int[8];
    private readonly string[] _slotHealth = new string[8] { "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok" };

    private readonly WallState _wallState = new()
    {
        Revision = 1,
        Layout = "4",
        Slots = Enumerable.Range(0, 8).Select(i => new SlotState
        {
            Index = i,
            Health = "ok",
            Muted = false,
            Volume = 1.0
        }).ToArray()
    };
    private bool _isCustomLayout;
    private CustomSlotRect[]? _currentCustomRects;

    // Cloud remote, tray and session state (alpha).
    private CloudBridge? _bridge;
    private AgentSettings _settings = new();
    private TrayIcon? _tray;
    private PairWindow? _pairWindow;
    private int _pairedPhoneCount = -1;
    private readonly System.Windows.Threading.DispatcherTimer _pairCheckTimer = new() { Interval = TimeSpan.FromSeconds(60) };
    private readonly TaskCompletionSource _webViewsReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _quitting;
    private bool _sessionActive;
    private string _localListenText = "";

    private const uint SwpNoActivate = 0x0010;
    private const uint SwpNoZOrder = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint flags);

    public MainWindow()
    {
        InitializeComponent();
        // The slot controls exist as soon as the XAML is loaded; their browsers
        // (CoreWebView2) are only created the first time the wall is shown, so an
        // idle laptop sitting in the tray runs no browser processes at all.
        _slots = new[] { Slot0, Slot1, Slot2, Slot3, Slot4, Slot5, Slot6, Slot7 };
        _borders = new[] { Border0, Border1, Border2, Border3, Border4, Border5, Border6, Border7 };
        _selectedMonitorIndex = GetPrimaryMonitorIndex();
        Loaded += MainWindow_Loaded;
        KeyDown += MainWindow_KeyDown;
    }

    /// <summary>
    /// Starts everything that must run even while the wall is hidden: the local
    /// command server, the cloud link to paired phones, and the tray icon.
    /// </summary>
    public void StartServices(bool background)
    {
        _settings = AgentStore.Load();
        StartupManager.RefreshPathIfEnabled();

        try
        {
            var bind = _settings.LanRemote ? IPAddress.Any : IPAddress.Loopback;
            _server = new CommandServer(ListenPort, bind);
            _server.CommandReceived += OnCommandReceived;
            _server.ClientJoined += () => Dispatcher.InvokeAsync(BroadcastWallStateAsync).Task;
            _server.Start();
            _localListenText = _settings.LanRemote
                ? $"Wi-Fi remote: {GetLocalIPv4()}:{ListenPort}"
                : $"Local remote: this PC only (port {ListenPort})";
        }
        catch (Exception ex)
        {
            _localListenText = $"Local remote off: {ex.Message}";
        }

        _bridge = new CloudBridge(_settings);
        _bridge.CommandReceived += OnCommandReceived;
        _bridge.ClientJoined += () => Dispatcher.InvokeAsync(async () =>
        {
            await BroadcastWallStateAsync();
            await SendDisplayStatusAsync();
        }).Task.Unwrap();
        _bridge.Paired += name => Dispatcher.InvokeAsync(() =>
        {
            _tray?.Notify("Phone paired", $"{name} can now control GameWall.");
            _ = RefreshPairingAsync(autoShow: false);
        });
        _bridge.StatusChanged += (_, _) => Dispatcher.InvokeAsync(UpdateStatusText);
        _bridge.Start();

        _tray = new TrayIcon(
            showWall: () => Dispatcher.InvokeAsync(async () => await EnsureWallVisibleAsync()),
            endSession: () => Dispatcher.InvokeAsync(EndSession),
            pairPhone: () => Dispatcher.InvokeAsync(() => ShowPairWindow(null)),
            showPairedPhones: () => Dispatcher.InvokeAsync(ShowPairedPhonesAsync),
            forgetPhones: () => Dispatcher.InvokeAsync(ForgetPhonesAsync),
            setLanRemote: enabled => Dispatcher.InvokeAsync(() => SetLanRemote(enabled)),
            lanRemoteEnabled: _settings.LanRemote,
            quit: () => Dispatcher.InvokeAsync(QuitApp));

        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        UpdateStatusText();

        _pairCheckTimer.Tick += (_, _) => _ = RefreshPairingAsync(autoShow: false);
        _pairCheckTimer.Start();

        if (!_settings.FirstRunDone)
        {
            _settings.FirstRunDone = true;
            AgentStore.Save(_settings);
            try { StartupManager.SetEnabled(true); } catch { }
            ShowPairWindow(
                "Welcome to the GameWall alpha. GameWall will now start quietly with Windows " +
                "and wait in the tray (turn that off from the tray icon). Pair your phone once " +
                "and you can start the wall from anywhere.");
        }
        else
        {
            // Not the first run: still check that a phone is linked. If none is (the phone
            // unpaired, or the server forgot this laptop), the code window opens by itself.
            _ = RefreshPairingAsync(autoShow: true);
        }

        if (!background) _ = EnsureWallVisibleAsync();
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await InitializeWebViewsAsync();
            SlotCanvas.SizeChanged += (_, _) => RenderCanvasSlots();
            ApplyLayout(_currentLayout);

            _watchdogTimer.Interval = TimeSpan.FromSeconds(2.5);
            _watchdogTimer.Tick += WatchdogTimer_Tick;
            _watchdogTimer.Start();

            UpdateStatusText();
            _ = BroadcastWallStateAsync();
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Startup failed: {ex.Message}";
            StatusText.Foreground = System.Windows.Media.Brushes.OrangeRed;
        }
        finally
        {
            _webViewsReady.TrySetResult();
        }
    }

    private void UpdateStatusText()
    {
        var cloud = _bridge is null ? "Cloud: starting" : $"Cloud: {_bridge.StatusMessage}";
        var name = _settings.DeviceName;
        StatusText.Text = $"{name} · {cloud} · {_localListenText}";
        var phones = _pairedPhoneCount switch
        {
            < 0 => "checking phone link",
            0 => "NO PHONE PAIRED",
            1 => "1 phone paired",
            var n => $"{n} phones paired",
        };
        _tray?.SetStatus(_bridge?.State == CloudBridge.LinkState.Online
            ? $"Online · {phones} · {(_sessionActive ? "wall showing" : "waiting for your phone")}"
            : $"{cloud} · {phones}");
    }

    /// <summary>
    /// Asks the server how many phones are paired with this laptop. With autoShow, opens
    /// the pairing-code window when there are none.
    /// </summary>
    private async Task RefreshPairingAsync(bool autoShow)
    {
        if (_bridge is null) return;
        try
        {
            var phones = await _bridge.GetPairedPhonesAsync();
            _pairedPhoneCount = phones.Length;
        }
        catch
        {
            // Offline or server unreachable: keep the last known count.
            if (_pairedPhoneCount < 0 && autoShow) ShowPairWindow("Couldn't check whether a phone is paired yet. If the code below doesn't load, check the internet connection.");
            UpdateStatusText();
            return;
        }
        UpdateStatusText();
        if (autoShow && _pairedPhoneCount == 0)
        {
            ShowPairWindow("No phone is paired with this laptop. Enter the code below in GameDay → Wall to link your phone.");
        }
        else if (autoShow)
        {
            _tray?.Notify("GameWall is ready", $"{_pairedPhoneCount} phone(s) paired. Start the wall from GameDay.");
        }
    }

    // ---------------------------------------------------------------- session lifecycle

    /// <summary>Shows the wall (creating the browsers on first use) and keeps the screen awake.</summary>
    private async Task EnsureWallVisibleAsync()
    {
        if (!IsVisible)
        {
            Show();
            if (_selectedMonitorIndex != GetPrimaryMonitorIndex()) MoveToMonitor(_selectedMonitorIndex);
        }
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Maximized;
        Activate();
        await _webViewsReady.Task;
        if (!_sessionActive)
        {
            _sessionActive = true;
            KeepAwake.Set(true);
            UpdateStatusText();
        }
    }

    /// <summary>Someone double-clicked GameWall while it was already running in the tray.</summary>
    public void ShowFromSecondLaunch() => _ = EnsureWallVisibleAsync();

    /// <summary>Clears every screen, hides the wall and lets the laptop sleep again.</summary>
    private void EndSession()
    {
        CloseAllSlots();
        Hide();
        _sessionActive = false;
        KeepAwake.Set(false);
        UpdateStatusText();
        _wallState.Revision++;
        _ = BroadcastWallStateAsync();
    }

    private void QuitApp()
    {
        _quitting = true;
        Close();
        System.Windows.Application.Current.Shutdown();
    }

    private void ShowPairWindow(string? welcome)
    {
        if (_bridge is null) return;
        if (_pairWindow is { IsLoaded: true })
        {
            _pairWindow.Activate();
            return;
        }
        _pairWindow = new PairWindow(_bridge, welcome);
        _pairWindow.Closed += (_, _) => _pairWindow = null;
        _pairWindow.Show();
        _pairWindow.Activate();
    }

    private async Task ShowPairedPhonesAsync()
    {
        if (_bridge is null) return;
        try
        {
            var phones = await _bridge.GetPairedPhonesAsync();
            _pairedPhoneCount = phones.Length;
            UpdateStatusText();
            var online = _bridge.GetClientNames();
            var lines = new List<string>
            {
                $"This laptop: {(_bridge.State == CloudBridge.LinkState.Online ? "ONLINE (reachable from your phone)" : "OFFLINE - " + _bridge.StatusMessage)}",
                "",
                phones.Length == 0
                    ? "Paired phones: NONE. Use \"Pair a phone…\" in the tray menu to get a code."
                    : "Paired phones:\n  " + string.Join("\n  ", phones),
                "",
                online.Length == 0
                    ? "Phones heard from recently: none (open GameDay → Wall on the phone to check in)"
                    : "Phones heard from recently:\n  " + string.Join("\n  ", online),
            };
            System.Windows.MessageBox.Show(string.Join(Environment.NewLine, lines),
                "Phone link", MessageBoxButton.OK,
                phones.Length == 0 ? MessageBoxImage.Warning : MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(ex.Message, "Phone link", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async Task ForgetPhonesAsync()
    {
        if (_bridge is null) return;
        var answer = System.Windows.MessageBox.Show(
            "Unpair every phone from this laptop? Each phone will need a new code to control the wall again.",
            "Forget all phones", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (answer != MessageBoxResult.Yes) return;
        try
        {
            await _bridge.ForgetAllPhonesAsync();
            _pairedPhoneCount = 0;
            UpdateStatusText();
            _tray?.Notify("Phones forgotten", "Pair again from the tray menu when you need to.");
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(ex.Message, "Forget all phones", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SetLanRemote(bool enabled)
    {
        _settings.LanRemote = enabled;
        AgentStore.Save(_settings);
        System.Windows.MessageBox.Show(
            enabled
                ? "The Wi-Fi remote will be allowed after you restart GameWall. Anyone on the same Wi-Fi can then control the wall, so only use it on your home network."
                : "The Wi-Fi remote will be turned off after you restart GameWall.",
            "Wi-Fi remote", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        Dispatcher.InvokeAsync(async () =>
        {
            await SendDisplayStatusAsync();
            var count = FormsScreen.AllScreens.Length;
            if (count > 1 && !_sessionActive)
                _tray?.Notify("Display connected", $"{count} screens found. Start the wall from GameDay on your phone.");
        });
    }

    /// <summary>Sends a message to every local remote and every paired phone.</summary>
    private Task PublishAsync(object message)
    {
        var local = _server?.BroadcastAsync(message) ?? Task.CompletedTask;
        var cloud = _bridge?.PublishAsync(message) ?? Task.CompletedTask;
        return Task.WhenAll(local, cloud);
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

        for (var index = 0; index < _slots.Length; index++)
        {
            var slot = _slots[index];
            await slot.EnsureCoreWebView2Async(_environment);
            slot.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            slot.CoreWebView2.Settings.AreDevToolsEnabled = false;
            var slotIndex = index;
            slot.CoreWebView2.ProcessFailed += (_, _) => Dispatcher.Invoke(() => RecoverSlot(slotIndex));
            slot.CoreWebView2.NavigationCompleted += (_, _) => _ = BroadcastHealthAsync(slotIndex, "ok");
            slot.CoreWebView2.Navigate("about:blank");
        }
    }

    private FractionalRect[] _currentFractionalRects = Layouts.FourUp.FractionalPlacements;

    private void RenderCanvasSlots()
    {
        var w = SlotCanvas.ActualWidth;
        var h = SlotCanvas.ActualHeight;
        if (w <= 0 || h <= 0) return;

        for (int i = 0; i < _borders.Length; i++)
        {
            if (i < _currentFractionalRects.Length)
            {
                var r = _currentFractionalRects[i];
                _borders[i].Visibility = Visibility.Visible;
                Canvas.SetLeft(_borders[i], Math.Round(r.X * w));
                Canvas.SetTop(_borders[i], Math.Round(r.Y * h));
                _borders[i].Width = Math.Max(0, Math.Round(r.Width * w));
                _borders[i].Height = Math.Max(0, Math.Round(r.Height * h));
                System.Windows.Controls.Panel.SetZIndex(_borders[i], i);
            }
            else
            {
                _borders[i].Visibility = Visibility.Collapsed;
            }
        }
    }

    private static string GetLayoutName(LayoutDefinition layout)
    {
        if (layout == Layouts.OneUp) return "1";
        if (layout == Layouts.TwoUp) return "2";
        if (layout == Layouts.FourUp) return "4";
        if (layout == Layouts.SixUp) return "6";
        if (layout == Layouts.EightUp) return "8";
        if (layout == Layouts.FeaturedPlusFour) return "featured";
        return "4";
    }

    private Task BroadcastWallStateAsync()
    {
        _wallState.ActiveMonitor = _selectedMonitorIndex;
        _wallState.Clients = (_server?.GetClientNames() ?? Array.Empty<string>())
            .Concat(_bridge?.GetClientNames() ?? Array.Empty<string>())
            .ToArray();
        _wallState.Layout = _isCustomLayout ? "custom" : GetLayoutName(_currentLayout);
        _wallState.CustomRects = _isCustomLayout ? _currentCustomRects : null;
        _wallState.SessionActive = _sessionActive;
        _wallState.DeviceName = _settings.DeviceName;
        return PublishAsync(_wallState);
    }

    /// <summary>Arranges the slots per the fractional coordinates of the given preset layout.</summary>
    private void ApplyLayout(LayoutDefinition layout, string? layoutName = null)
    {
        _isCustomLayout = false;
        _currentCustomRects = null;
        _currentLayout = layout;
        _currentFractionalRects = layout.FractionalPlacements;
        _wallState.Layout = layoutName ?? GetLayoutName(layout);
        _wallState.CustomRects = null;
        RenderCanvasSlots();
    }

    /// <summary>Arranges the slots per arbitrary normalized fractional coordinates (custom layout).</summary>
    private void ApplyCustomLayout(CustomSlotRect[] customRects)
    {
        _isCustomLayout = true;
        _currentCustomRects = customRects;
        var list = new List<FractionalRect>();
        for (int i = 0; i < Math.Min(customRects.Length, 8); i++)
        {
            var cr = customRects[i];
            list.Add(new FractionalRect(cr.X, cr.Y, cr.Width, cr.Height));
        }
        _currentFractionalRects = list.ToArray();
        _wallState.Layout = "custom";
        _wallState.CustomRects = customRects;
        RenderCanvasSlots();
    }

    private void RestoreWallStateSnapshot(WallState snapshot)
    {
        if (snapshot.Layout.Equals("custom", StringComparison.OrdinalIgnoreCase) && snapshot.CustomRects is { Length: > 0 })
        {
            ApplyCustomLayout(snapshot.CustomRects);
        }
        else
        {
            ApplyLayout(Layouts.ByName(snapshot.Layout), snapshot.Layout);
        }

        if (snapshot.Slots is not null)
        {
            for (int i = 0; i < Math.Min(_slots.Length, snapshot.Slots.Length); i++)
            {
                var target = snapshot.Slots[i];
                var current = _wallState.Slots[i];

                current.Label = target.Label;
                current.Network = target.Network;
                current.GameId = target.GameId;
                current.LastUrl = target.LastUrl;
                current.LastLabel = target.LastLabel;
                current.LastNetwork = target.LastNetwork;
                current.LastGameJson = target.LastGameJson;
                current.Muted = target.Muted;
                current.Volume = target.Volume;

                SetMute(i, target.Muted);
                _ = SetVolumeAsync(i, target.Volume);

                if (!string.IsNullOrWhiteSpace(target.Url))
                {
                    _lastUrls[i] = target.Url;
                    current.Url = target.Url;
                    _slots[i].CoreWebView2?.Navigate(target.Url);
                }
                else
                {
                    _lastUrls[i] = null;
                    current.Url = null;
                    _slots[i].CoreWebView2?.Navigate("about:blank");
                }
            }
        }

        _wallState.Revision++;
        _ = BroadcastWallStateAsync();
    }

    // Commands that put something on screen bring the wall up first.
    private static readonly HashSet<string> WallActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "navigate", "layout", "test", "restoreSnapshot", "applyWallState", "monitor",
    };

    private void OnCommandReceived(SlotCommand cmd)
    {
        // WebView2/UI must be touched from the UI thread.
        Dispatcher.InvokeAsync(async () =>
        {
            try
            {
                if (WallActions.Contains(cmd.Action)) await EnsureWallVisibleAsync();
                ApplyCommand(cmd);
            }
            catch (Exception ex)
            {
                StatusText.Text = $"Command {cmd.Action} failed: {ex.Message}";
            }
        });
    }

    private void ApplyCommand(SlotCommand cmd)
    {
        {
            switch (cmd.Action)
            {
                case "navigate":
                    if (cmd.Slot is int ns && ns is >= 0 and < 8 && cmd.Url is not null)
                    {
                        _lastUrls[ns] = cmd.Url;
                        _slots[ns].CoreWebView2?.Navigate(cmd.Url);

                        var s = _wallState.Slots[ns];
                        s.Url = cmd.Url;
                        s.Label = cmd.Label ?? s.Label ?? cmd.Url;
                        s.Network = cmd.Network ?? s.Network;
                        s.GameId = cmd.GameId ?? s.GameId;
                        s.LastUrl = cmd.Url;
                        s.LastLabel = s.Label;
                        s.LastNetwork = s.Network;
                        if (cmd.LastGameJson is not null) s.LastGameJson = cmd.LastGameJson;

                        _wallState.Revision++;
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "mute":
                    if (cmd.Slot is int ms && ms is >= 0 and < 8 && cmd.Muted is bool muted)
                    {
                        SetMute(ms, muted);
                        _wallState.Slots[ms].Muted = muted;
                        _wallState.Revision++;
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "volume":
                    if (cmd.Slot is int vs && vs is >= 0 and < 8 && cmd.Volume is double vol)
                    {
                        var clamped = Math.Clamp(vol, 0.0, 1.0);
                        _ = SetVolumeAsync(vs, clamped);
                        _wallState.Slots[vs].Volume = clamped;
                        _wallState.Revision++;
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "close":
                    if (cmd.Slot is int cs && cs is >= 0 and < 8)
                    {
                        _lastUrls[cs] = null;
                        _stallFailures[cs] = 0;
                        _slots[cs].CoreWebView2?.Navigate("about:blank");

                        var s = _wallState.Slots[cs];
                        s.Url = null;
                        s.Label = null;
                        s.Network = null;
                        s.Health = "ok";
                        _slotHealth[cs] = "ok";

                        _wallState.Revision++;
                        _ = BroadcastHealthAsync(cs, "ok");
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "clear":
                    if (cmd.Slot is int clrS && clrS is >= 0 and < 8)
                    {
                        _lastUrls[clrS] = null;
                        _stallFailures[clrS] = 0;
                        _slots[clrS].CoreWebView2?.Navigate("about:blank");

                        var s = _wallState.Slots[clrS];
                        s.Url = null;
                        s.Label = null;
                        s.Network = null;
                        s.GameId = null;
                        s.LastUrl = null;
                        s.LastLabel = null;
                        s.LastNetwork = null;
                        s.LastGameJson = null;
                        s.Health = "ok";
                        _slotHealth[clrS] = "ok";

                        _wallState.Revision++;
                        _ = BroadcastHealthAsync(clrS, "ok");
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "closeAll":
                    CloseAllSlots();
                    _wallState.Revision++;
                    _ = BroadcastWallStateAsync();
                    break;

                case "endSession":
                    EndSession();
                    break;

                case "identify":
                    ShowIdentify(cmd.From);
                    break;

                case "layout":
                    if (cmd.Layout is not null)
                    {
                        if (cmd.Layout.Equals("custom", StringComparison.OrdinalIgnoreCase) && cmd.Rects is { Length: > 0 })
                            ApplyCustomLayout(cmd.Rects);
                        else
                            ApplyLayout(Layouts.ByName(cmd.Layout), cmd.Layout);

                        _wallState.Revision++;
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "restoreSnapshot":
                case "applyWallState":
                    if (cmd.Snapshot is not null)
                    {
                        RestoreWallStateSnapshot(cmd.Snapshot);
                    }
                    break;

                case "syncSlot":
                    if (cmd.Slot is int syncSlot && syncSlot is >= 0 and < 8)
                    {
                        var s = _wallState.Slots[syncSlot];
                        if (cmd.Label is not null) s.Label = cmd.Label;
                        if (cmd.Network is not null) s.Network = cmd.Network;
                        if (cmd.GameId is not null) s.GameId = cmd.GameId;
                        if (cmd.Url is not null) s.Url = cmd.Url;
                        if (cmd.LastGameJson is not null) s.LastGameJson = cmd.LastGameJson;
                        _wallState.Revision++;
                        _ = BroadcastWallStateAsync();
                    }
                    break;

                case "wallState":
                    _ = BroadcastWallStateAsync();
                    break;

                case "test":
                    RunTestMode();
                    break;

                case "displays":
                    _ = SendDisplayStatusAsync();
                    break;

                case "monitor":
                    if (cmd.Monitor is int monitorIndex)
                        MoveToMonitor(monitorIndex);
                    break;
            }
        }
    }

    private void CloseAllSlots()
    {
        for (var s = 0; s < _slots.Length; s++)
        {
            _lastUrls[s] = null;
            _stallFailures[s] = 0;
            _slots[s].CoreWebView2?.Navigate("about:blank");
            _slotHealth[s] = "ok";

            var slotState = _wallState.Slots[s];
            slotState.Url = null;
            slotState.Label = null;
            slotState.Network = null;
            slotState.Health = "ok";
        }
    }

    /// <summary>Flashes this laptop's name on the wall so you know which one you're controlling.</summary>
    private async void ShowIdentify(string? from)
    {
        StatusOverlay.Visibility = Visibility.Visible;
        var before = StatusText.Text;
        StatusText.Text = $"This is {_settings.DeviceName}" + (string.IsNullOrWhiteSpace(from) ? "" : $" (asked by {from})");
        StatusText.FontSize = 28;
        await Task.Delay(4000);
        StatusText.FontSize = 13;
        StatusText.Text = before;
        UpdateStatusText();
    }

    private void MoveToMonitor(int monitorIndex)
    {
        var screens = FormsScreen.AllScreens;
        if (monitorIndex < 0 || monitorIndex >= screens.Length)
        {
            StatusText.Text = $"Invalid monitor selection: {monitorIndex}";
            return;
        }

        var bounds = screens[monitorIndex].Bounds;
        var windowHandle = new WindowInteropHelper(this).Handle;
        WindowState = WindowState.Normal;
        if (!SetWindowPos(windowHandle, IntPtr.Zero, bounds.Left, bounds.Top,
                bounds.Width, bounds.Height, SwpNoActivate | SwpNoZOrder))
        {
            var error = Marshal.GetLastWin32Error();
            StatusText.Text = $"Could not move to monitor {monitorIndex}: Win32 error {error}";
            return;
        }

        WindowState = WindowState.Maximized;
        _selectedMonitorIndex = monitorIndex;
        _ = SendDisplayStatusAsync();
        _ = BroadcastWallStateAsync();
    }

    private async Task SendDisplayStatusAsync()
    {
        var screens = FormsScreen.AllScreens;
        if (_selectedMonitorIndex >= screens.Length)
            _selectedMonitorIndex = GetPrimaryMonitorIndex(screens);

        await PublishAsync(new DisplayStatus
        {
            SelectedIndex = _selectedMonitorIndex,
            Displays = screens.Select((screen, index) => new DisplayInfo
            {
                Index = index,
                Name = string.IsNullOrWhiteSpace(screen.DeviceName)
                    ? $"Monitor {index + 1}"
                    : screen.DeviceName,
                Width = screen.Bounds.Width,
                Height = screen.Bounds.Height,
            }).ToArray(),
        });
    }

    private void RecoverSlot(int slotIndex)
    {
        var core = _slots[slotIndex].CoreWebView2;
        if (core is null) return;
        _stallFailures[slotIndex] = 0;
        _ = BroadcastHealthAsync(slotIndex, "recovered");
        if (!string.IsNullOrWhiteSpace(_lastUrls[slotIndex]))
            core.Navigate(_lastUrls[slotIndex]!);
        else
            core.Reload();
    }

    private Task BroadcastHealthAsync(int slotIndex, string status)
    {
        _slotHealth[slotIndex] = status;
        if (slotIndex >= 0 && slotIndex < _wallState.Slots.Length)
        {
            _wallState.Slots[slotIndex].Health = status;
        }
        _ = PublishAsync(new SlotHealth { Slot = slotIndex, Status = status });
        return BroadcastWallStateAsync();
    }

    private async void WatchdogTimer_Tick(object? sender, EventArgs e)
    {
        for (var i = 0; i < _slots.Length; i++)
        {
            var url = _lastUrls[i];
            if (string.IsNullOrWhiteSpace(url) || url == "about:blank")
            {
                _stallFailures[i] = 0;
                continue;
            }

            var core = _slots[i].CoreWebView2;
            if (core is null) continue;

            bool checkOk = false;
            try
            {
                var evalTask = core.ExecuteScriptAsync("document.readyState");
                var completed = await Task.WhenAny(evalTask, Task.Delay(1500));
                if (completed == evalTask && evalTask.Result is not null)
                {
                    checkOk = true;
                }
            }
            catch
            {
                checkOk = false;
            }

            if (!checkOk)
            {
                _stallFailures[i]++;
                if (_stallFailures[i] >= 5)
                {
                    _stallFailures[i] = 0;
                    RecoverSlot(i);
                }
                else if (_stallFailures[i] >= 3 && _slotHealth[i] != "stalled")
                {
                    _ = BroadcastHealthAsync(i, "stalled");
                }
            }
            else
            {
                if (_stallFailures[i] > 0 || _slotHealth[i] != "ok")
                {
                    _stallFailures[i] = 0;
                    _ = BroadcastHealthAsync(i, "ok");
                }
            }
        }
    }

    private static int GetPrimaryMonitorIndex()
    {
        return GetPrimaryMonitorIndex(FormsScreen.AllScreens);
    }

    private static int GetPrimaryMonitorIndex(FormsScreen[] screens)
    {
        var primaryIndex = Array.FindIndex(screens, screen => screen.Primary);
        return primaryIndex >= 0 ? primaryIndex : 0;
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
        _wallState.Revision++;
        _ = BroadcastWallStateAsync();
        for (int i = 0; i < TestUrls.Length; i++)
            _slots[i].CoreWebView2?.Navigate(TestUrls[i]);
    }

    private void MainWindow_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.F5:
                RunTestMode();
                break;
            case Key.Escape:
                // Esc now ends the session and hides the wall; GameWall keeps waiting
                // in the tray. Quit from the tray menu.
                EndSession();
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

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        // Closing the wall window (Alt+F4, taskbar) hides it; only "Quit" exits.
        if (!_quitting)
        {
            e.Cancel = true;
            EndSession();
            return;
        }
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        _watchdogTimer.Stop();
        _server?.Stop();
        _bridge?.Dispose();
        _tray?.Dispose();
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        KeepAwake.Set(false);
        base.OnClosed(e);
    }
}
