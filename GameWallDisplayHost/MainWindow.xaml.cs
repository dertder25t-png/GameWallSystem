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

    // ---- GPU / stability guards -------------------------------------------------------
    // Every slot is a full Chromium video player sharing ONE GPU process, so the wall's
    // biggest danger is piling work onto the graphics driver all at once. These fields
    // keep that load down and stop recovery logic from hammering a driver that just fell over.

    /// <summary>Slot has a URL but is off-screen in the current layout, so it's held on about:blank.</summary>
    private readonly bool[] _parked = new bool[8];
    /// <summary>Slot was left blank on purpose after repeated GPU crashes, until the phone reloads it.</summary>
    private readonly bool[] _heldAfterGpuCrash = new bool[8];
    private readonly RecoveryBackoff[] _backoff = Enumerable.Range(0, 8).Select(_ => new RecoveryBackoff()).ToArray();
    private readonly List<DateTime> _gpuCrashes = new();
    private DateTime _lastGpuCrash = DateTime.MinValue;
    private int _gpuRecoveryGeneration;
    private int _loadGeneration;
    private bool _watchdogRunning;
    /// <summary>The shared WebView2 browser process exited; every slot is dead until GameWall restarts.</summary>
    private bool _videoEngineStopped;

    /// <summary>Gap between starting each stream when several load together.</summary>
    private static readonly TimeSpan StaggerDelay = TimeSpan.FromMilliseconds(900);
    /// <summary>Probe failures in a row before a slot counts as stalled / gets reloaded.</summary>
    private const int StalledAfter = 2;
    private const int ReloadAfter = 4;
    /// <summary>GPU crashes within <see cref="GpuCrashWindow"/> before the wall sheds load.</summary>
    private const int GpuCrashLimit = 3;
    private static readonly TimeSpan GpuCrashWindow = TimeSpan.FromMinutes(10);
    /// <summary>Screens still reloaded automatically once the GPU crash limit is hit.</summary>
    private const int SlotsKeptAfterRepeatedGpuCrashes = 2;

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
    /// <summary>Waits for a burst of display changes (a projector connecting) to settle.</summary>
    private readonly System.Windows.Threading.DispatcherTimer _displaysSettledTimer = new() { Interval = TimeSpan.FromSeconds(1.5) };
    private int _lastScreenCount = FormsScreen.AllScreens.Length;
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

        _displaysSettledTimer.Tick += OnDisplaysSettled;
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

            _watchdogTimer.Interval = TimeSpan.FromSeconds(5);
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

    /// <summary>
    /// Arrives on a system thread, often several times in a row while a projector or TV
    /// negotiates its mode. Restart a short timer so the work below happens once per burst.
    /// </summary>
    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        Dispatcher.InvokeAsync(() =>
        {
            _displaysSettledTimer.Stop();
            _displaysSettledTimer.Start();
        });
    }

    private async void OnDisplaysSettled(object? sender, EventArgs e)
    {
        _displaysSettledTimer.Stop();
        try
        {
            var screens = FormsScreen.AllScreens;
            // The wall's monitor went away (projector unplugged): put the wall back on the
            // main screen, full size, rather than wherever Windows dropped it.
            if (_selectedMonitorIndex >= screens.Length && IsVisible)
                MoveToMonitor(GetPrimaryMonitorIndex(screens));

            await SendDisplayStatusAsync();

            // Toast only when a screen was added, not on every resolution change.
            if (screens.Length > 1 && screens.Length > _lastScreenCount && !_sessionActive)
                _tray?.Notify("Display connected", $"{screens.Length} screens found. Start the wall from GameDay on your phone.");
            _lastScreenCount = screens.Length;
        }
        catch (Exception ex)
        {
            App.LogError("Display change", ex);
        }
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
            // InvokeAsync, not Invoke: a GPU crash fires this on all 8 slots at once, and
            // a blocking Invoke from each of them is how the old handler froze the UI.
            slot.CoreWebView2.ProcessFailed += (_, args) =>
            {
                var kind = args.ProcessFailedKind;
                Dispatcher.InvokeAsync(() => OnProcessFailed(slotIndex, kind));
            };
            slot.CoreWebView2.NavigationCompleted += (_, _) =>
            {
                // A slot held blank after repeated GPU crashes stays "stalled" on the phone
                // until someone reloads it; its about:blank finishing loading isn't recovery.
                if (_heldAfterGpuCrash[slotIndex]) return;
                _ = BroadcastHealthAsync(slotIndex, "ok");
            };
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
    /// <param name="resumeParked">
    /// False when the caller is about to load new URLs with <see cref="LoadSlotsStaggered"/>:
    /// slots coming back into view then wait for their turn instead of restarting the old stream.
    /// </param>
    private void ApplyLayout(LayoutDefinition layout, string? layoutName = null, bool resumeParked = true)
    {
        _isCustomLayout = false;
        _currentCustomRects = null;
        _currentLayout = layout;
        _currentFractionalRects = layout.FractionalPlacements;
        _wallState.Layout = layoutName ?? GetLayoutName(layout);
        _wallState.CustomRects = null;
        RenderCanvasSlots();
        UpdateParking(resumeParked);
    }

    /// <summary>Arranges the slots per arbitrary normalized fractional coordinates (custom layout).</summary>
    private void ApplyCustomLayout(CustomSlotRect[] customRects, bool resumeParked = true)
    {
        customRects = Layouts.SanitizeCustomRects(customRects);
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
        UpdateParking(resumeParked);
    }

    private void RestoreWallStateSnapshot(WallState snapshot)
    {
        // When the snapshot brings its own URLs, the staggered load below starts every
        // shown slot; letting the layout change resume parked slots first would briefly
        // restart their old streams.
        var resumeParked = snapshot.Slots is null;
        var layoutName = string.IsNullOrWhiteSpace(snapshot.Layout) ? "4" : snapshot.Layout;
        if (layoutName.Equals("custom", StringComparison.OrdinalIgnoreCase) && snapshot.CustomRects is { Length: > 0 })
        {
            ApplyCustomLayout(snapshot.CustomRects, resumeParked);
        }
        else
        {
            ApplyLayout(Layouts.ByName(layoutName), layoutName, resumeParked);
        }

        if (snapshot.Slots is not null)
        {
            // Slots the snapshot doesn't mention keep whatever they're showing.
            var urls = (string?[])_lastUrls.Clone();
            for (int i = 0; i < Math.Min(_slots.Length, snapshot.Slots.Length); i++)
            {
                var target = snapshot.Slots[i];
                if (target is null) continue;
                var current = _wallState.Slots[i];
                var volume = double.IsFinite(target.Volume) ? Math.Clamp(target.Volume, 0.0, 1.0) : 1.0;

                current.Label = target.Label;
                current.Network = target.Network;
                current.GameId = target.GameId;
                current.LastUrl = target.LastUrl;
                current.LastLabel = target.LastLabel;
                current.LastNetwork = target.LastNetwork;
                current.LastGameJson = target.LastGameJson;
                current.Muted = target.Muted;
                current.Volume = volume;

                SetMute(i, target.Muted);
                _ = SetVolumeAsync(i, volume);

                urls[i] = CommandRules.IsPlayableUrl(target.Url) ? target.Url : null;
                current.Url = urls[i];
            }
            // Starting up to 8 streams in the same instant is the heaviest thing the
            // wall ever does to the GPU, so they start one after another instead.
            LoadSlotsStaggered(urls);
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
                        if (!CommandRules.IsPlayableUrl(cmd.Url))
                        {
                            StatusText.Text = $"Screen {ns + 1}: ignored a link that isn't a web address.";
                            break;
                        }

                        LoadSlot(ns, cmd.Url);

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
                        LoadSlot(cs, null);

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
                        LoadSlot(clrS, null);

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
        _loadGeneration++; // cancels any staggered load still in progress
        _gpuRecoveryGeneration++; // and any GPU-crash recovery still bringing screens back
        if (!_videoEngineStopped)
        {
            StatusText.Foreground = System.Windows.Media.Brushes.White;
            UpdateStatusText();
        }
        for (var s = 0; s < _slots.Length; s++)
        {
            LoadSlot(s, null);
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
        try
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
        catch (Exception ex)
        {
            App.LogError("ShowIdentify", ex);
        }
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
        var url = _lastUrls[slotIndex];
        // Nothing to bring back, or the slot is deliberately blank right now.
        if (string.IsNullOrWhiteSpace(url) || _parked[slotIndex] || _heldAfterGpuCrash[slotIndex]) return;
        _ = BroadcastHealthAsync(slotIndex, "recovered");
        SafeNavigate(slotIndex, url);
    }

    /// <summary>
    /// Reloads a slot, but backs off if it keeps failing (see <see cref="RecoveryBackoff"/>)
    /// so a stream that can't play doesn't get restarted every few seconds.
    /// </summary>
    private void ScheduleRecovery(int slotIndex)
    {
        if (!_backoff[slotIndex].TryRecover(DateTime.UtcNow))
        {
            if (_slotHealth[slotIndex] != "stalled") _ = BroadcastHealthAsync(slotIndex, "stalled");
            return;
        }
        RecoverSlot(slotIndex);
    }

    private void OnProcessFailed(int slotIndex, CoreWebView2ProcessFailedKind kind)
    {
        // Nothing can be reloaded once the browser itself is gone.
        if (_videoEngineStopped) return;
        switch (kind)
        {
            case CoreWebView2ProcessFailedKind.GpuProcessExited:
                OnGpuProcessExited();
                break;

            case CoreWebView2ProcessFailedKind.RenderProcessExited:
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
            case CoreWebView2ProcessFailedKind.FrameRenderProcessExited:
                ScheduleRecovery(slotIndex);
                break;

            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                // The shared browser is gone for every slot (this event arrives once per
                // slot). It can't be revived in place, and the browsers are only created
                // once per run, so ending and restarting the session doesn't help either.
                _videoEngineStopped = true;
                _gpuRecoveryGeneration++;
                _loadGeneration++;
                StatusText.Text = "The video engine stopped. Quit GameWall from the tray icon and start it again.";
                StatusText.Foreground = System.Windows.Media.Brushes.OrangeRed;
                StatusOverlay.Visibility = Visibility.Visible;
                _tray?.Notify("GameWall video engine stopped", "Quit GameWall from the tray icon and start it again.");
                for (var i = 0; i < _slots.Length; i++)
                    if (_lastUrls[i] is not null) _ = BroadcastHealthAsync(i, "stalled");
                break;

            default:
                // Utility / sandbox helper processes restart on their own; reloading
                // the video for them only adds load.
                break;
        }
    }

    /// <summary>
    /// The shared GPU process died (driver reset, out of video memory, etc.). The old
    /// code reloaded all 8 streams that same instant, which is the exact load that
    /// knocked the driver over, and often crashed it again. Now: wait for the driver
    /// to settle, bring screens back one at a time, and shed load if it keeps happening.
    /// </summary>
    private void OnGpuProcessExited()
    {
        var now = DateTime.UtcNow;
        // One GPU crash is reported once per slot; treat that burst as a single event.
        if (now - _lastGpuCrash < TimeSpan.FromSeconds(5)) return;
        _lastGpuCrash = now;
        _gpuCrashes.Add(now);
        _gpuCrashes.RemoveAll(t => now - t > GpuCrashWindow);
        _ = RecoverAfterGpuCrashAsync(_gpuCrashes.Count);
    }

    private async Task RecoverAfterGpuCrashAsync(int recentCrashes)
    {
        var generation = ++_gpuRecoveryGeneration;
        var shedLoad = recentCrashes >= GpuCrashLimit;

        StatusOverlay.Visibility = Visibility.Visible;
        StatusText.Foreground = System.Windows.Media.Brushes.Orange;
        StatusText.Text = shedLoad
            ? $"Graphics driver crashed {recentCrashes} times in {GpuCrashWindow.TotalMinutes:0} min. Bringing back {SlotsKeptAfterRepeatedGpuCrashes} screens only; reload the others from your phone."
            : "Graphics driver reset. Bringing screens back one at a time…";

        await Task.Delay(TimeSpan.FromSeconds(4));
        if (generation != _gpuRecoveryGeneration) return;

        var kept = 0;
        for (var i = 0; i < _slots.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(_lastUrls[i]) || _parked[i] || _heldAfterGpuCrash[i]) continue;
            if (shedLoad && kept >= SlotsKeptAfterRepeatedGpuCrashes)
            {
                _heldAfterGpuCrash[i] = true;
                SafeNavigate(i, "about:blank");
                SetMemoryLow(i, true);
                _ = BroadcastHealthAsync(i, "stalled");
                continue;
            }
            kept++;
            RecoverSlot(i);
            await Task.Delay(TimeSpan.FromSeconds(2));
            if (generation != _gpuRecoveryGeneration) return;
        }

        StatusText.Foreground = System.Windows.Media.Brushes.White;
        UpdateStatusText();
    }

    private bool IsSlotShown(int slotIndex) => slotIndex < _currentFractionalRects.Length;

    /// <summary>
    /// Points a slot at a URL (or clears it with null). If the slot is off-screen in the
    /// current layout, the URL is remembered but nothing plays until the slot is shown.
    /// </summary>
    private void LoadSlot(int slotIndex, string? url)
    {
        _lastUrls[slotIndex] = string.IsNullOrWhiteSpace(url) ? null : url;
        _stallFailures[slotIndex] = 0;
        _backoff[slotIndex].Reset();
        _heldAfterGpuCrash[slotIndex] = false; // a new load from the phone lifts the hold

        if (_lastUrls[slotIndex] is null)
        {
            _parked[slotIndex] = false;
            SafeNavigate(slotIndex, "about:blank");
            SetMemoryLow(slotIndex, true);
        }
        else if (!IsSlotShown(slotIndex))
        {
            if (!_parked[slotIndex]) SafeNavigate(slotIndex, "about:blank");
            _parked[slotIndex] = true;
            SetMemoryLow(slotIndex, true);
        }
        else
        {
            _parked[slotIndex] = false;
            SetMemoryLow(slotIndex, false);
            SafeNavigate(slotIndex, _lastUrls[slotIndex]!);
        }
    }

    /// <summary>Loads several slots one after another instead of all in the same instant.</summary>
    private async void LoadSlotsStaggered(string?[] urls)
    {
        try
        {
            var generation = ++_loadGeneration;

            // Clear or park everything first so nothing from the old wall keeps decoding.
            for (var i = 0; i < _slots.Length; i++)
            {
                if (urls[i] is null) LoadSlot(i, null);
                else if (!IsSlotShown(i)) LoadSlot(i, urls[i]);
                else _lastUrls[i] = urls[i];
            }

            var first = true;
            for (var i = 0; i < _slots.Length; i++)
            {
                if (urls[i] is null || !IsSlotShown(i)) continue;
                if (!first) await Task.Delay(StaggerDelay);
                first = false;
                // A newer staggered load, closeAll or endSession took over: stop here.
                if (generation != _loadGeneration) return;
                // A newer command took over this one slot meanwhile.
                if (_lastUrls[i] != urls[i]) continue;
                LoadSlot(i, urls[i]);
            }
        }
        catch (Exception ex)
        {
            App.LogError("LoadSlotsStaggered", ex);
        }
    }

    /// <summary>
    /// Slots outside the current layout are collapsed, but a collapsed WebView2 keeps
    /// decoding its video (and playing its audio) in the background. Park those on
    /// about:blank and bring them back when the layout shows them again.
    /// </summary>
    private void UpdateParking(bool resumeParked = true)
    {
        var restoreDelay = TimeSpan.Zero;
        for (var i = 0; i < _slots.Length; i++)
        {
            var shown = IsSlotShown(i);
            if (!shown && !_parked[i] && _lastUrls[i] is not null)
            {
                _parked[i] = true;
                _stallFailures[i] = 0;
                SafeNavigate(i, "about:blank");
                SetMemoryLow(i, true);
            }
            else if (shown && _parked[i])
            {
                _parked[i] = false;
                var url = _lastUrls[i];
                if (!resumeParked || url is null || _heldAfterGpuCrash[i]) continue;
                SetMemoryLow(i, false);
                _ = UnparkAfterAsync(i, url, restoreDelay);
                restoreDelay += StaggerDelay;
            }
        }
    }

    private async Task UnparkAfterAsync(int slotIndex, string url, TimeSpan delay)
    {
        var generation = _loadGeneration;
        if (delay > TimeSpan.Zero) await Task.Delay(delay);
        if (generation != _loadGeneration || _parked[slotIndex] || _lastUrls[slotIndex] != url) return;
        SafeNavigate(slotIndex, url);
    }

    private void SafeNavigate(int slotIndex, string url)
    {
        // Calls into a dead browser only throw, and would replace the "video engine
        // stopped" message with a less useful one.
        if (_videoEngineStopped) return;
        try
        {
            _slots[slotIndex].CoreWebView2?.Navigate(url);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Screen {slotIndex + 1} couldn't load: {ex.Message}";
        }
    }

    /// <summary>Tells WebView2 an idle slot can give back memory (no-op on older runtimes).</summary>
    private void SetMemoryLow(int slotIndex, bool low)
    {
        try
        {
            var core = _slots[slotIndex].CoreWebView2;
            if (core is null) return;
            core.MemoryUsageTargetLevel = low
                ? CoreWebView2MemoryUsageTargetLevel.Low
                : CoreWebView2MemoryUsageTargetLevel.Normal;
        }
        catch
        {
            // Older WebView2 runtime without this API: nothing to do.
        }
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
        // The old tick awaited up to 1.5 s per slot one after another (12 s for 8 slots)
        // while the timer kept firing every 2.5 s, so ticks stacked up and could reload
        // the same slot several times over. One pass at a time now, all slots in parallel.
        if (_watchdogRunning || !IsVisible || _videoEngineStopped) return;
        _watchdogRunning = true;
        try
        {
            var probes = new List<(int Slot, string Url, Task<bool> Ok)>();
            for (var i = 0; i < _slots.Length; i++)
            {
                var url = _lastUrls[i];
                if (string.IsNullOrWhiteSpace(url) || url == "about:blank" || _parked[i] || _heldAfterGpuCrash[i])
                {
                    _stallFailures[i] = 0;
                    continue;
                }
                var core = _slots[i].CoreWebView2;
                if (core is null) continue;
                probes.Add((i, url, ProbeAsync(core)));
            }

            foreach (var (i, probedUrl, probe) in probes)
            {
                var checkOk = await probe;
                // The slot was closed, parked, held or given a new stream while we waited.
                if (_lastUrls[i] != probedUrl || _parked[i] || _heldAfterGpuCrash[i]) continue;
                if (!checkOk)
                {
                    _backoff[i].ReportUnhealthy();
                    _stallFailures[i]++;
                    if (_stallFailures[i] >= ReloadAfter)
                    {
                        _stallFailures[i] = 0;
                        ScheduleRecovery(i);
                    }
                    else if (_stallFailures[i] >= StalledAfter && _slotHealth[i] != "stalled")
                    {
                        _ = BroadcastHealthAsync(i, "stalled");
                    }
                }
                else
                {
                    _backoff[i].ReportHealthy(DateTime.UtcNow);
                    if (_stallFailures[i] > 0 || _slotHealth[i] != "ok")
                    {
                        _stallFailures[i] = 0;
                        _ = BroadcastHealthAsync(i, "ok");
                    }
                }
            }
        }
        catch (Exception ex)
        {
            App.LogError("Watchdog", ex);
        }
        finally
        {
            _watchdogRunning = false;
        }
    }

    private static async Task<bool> ProbeAsync(CoreWebView2 core)
    {
        try
        {
            var evalTask = core.ExecuteScriptAsync("document.readyState");
            var completed = await Task.WhenAny(evalTask, Task.Delay(1500));
            return completed == evalTask && await evalTask is not null;
        }
        catch
        {
            return false;
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
        ApplyLayout(Layouts.EightUp, resumeParked: false);
        _wallState.Revision++;
        _ = BroadcastWallStateAsync();
        LoadSlotsStaggered(TestUrls.Select(u => (string?)u).ToArray());
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
        _displaysSettledTimer.Stop();
        _pairCheckTimer.Stop();
        _server?.Stop();
        _bridge?.Dispose();
        _tray?.Dispose();
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        KeepAwake.Set(false);
        base.OnClosed(e);
    }
}
