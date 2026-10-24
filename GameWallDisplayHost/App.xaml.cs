using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Threading;

namespace GameWallDisplayHost;

/// <summary>
/// Starts GameWall. With --background (how Windows starts it at sign-in) it waits
/// in the tray with the wall hidden until a paired phone sends something to show.
/// Only one copy runs: starting it again just brings the wall up.
/// </summary>
public partial class App : System.Windows.Application
{
    private const string MutexName = @"Local\GameWall.DisplayHost";
    private const string ShowEventName = @"Local\GameWall.DisplayHost.Show";

    private Mutex? _singleInstance;
    private EventWaitHandle? _showSignal;
    private RegisteredWaitHandle? _showWait;
    private readonly Queue<DateTime> _recentUiErrors = new();

    private static readonly object LogGate = new();
    private static string LogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GameWallDisplayHost", "errors.log");

    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            LogError("Background task", args.Exception);
            args.SetObserved();
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) => LogError("Fatal", args.ExceptionObject as Exception);

        base.OnStartup(e);

        _singleInstance = new Mutex(initiallyOwned: true, MutexName, out var isFirst);
        if (!isFirst)
        {
            // Already running (probably in the tray): ask it to show the wall, then exit.
            try
            {
                using var signal = EventWaitHandle.OpenExisting(ShowEventName);
                signal.Set();
            }
            catch (WaitHandleCannotBeOpenedException) { }
            Shutdown();
            return;
        }

        var background = e.Args.Any(a => string.Equals(a, "--background", StringComparison.OrdinalIgnoreCase));
        var window = new MainWindow();
        MainWindow = window;
        window.StartServices(background);

        _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        _showWait = ThreadPool.RegisterWaitForSingleObject(_showSignal, (_, _) =>
            Dispatcher.InvokeAsync(() => window.ShowFromSecondLaunch()), null, Timeout.Infinite, executeOnlyOnce: false);
    }

    /// <summary>
    /// The wall runs unattended through a game, so one bad event handler shouldn't take all
    /// 8 screens down: log it and keep going. If errors pour in (something is stuck failing
    /// on every frame), give up and let the app close instead of spinning.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogError("UI thread", e.Exception);
        var now = DateTime.UtcNow;
        _recentUiErrors.Enqueue(now);
        while (_recentUiErrors.Count > 0 && now - _recentUiErrors.Peek() > TimeSpan.FromSeconds(10))
            _recentUiErrors.Dequeue();
        e.Handled = _recentUiErrors.Count <= 20;
    }

    /// <summary>Appends an error to %LOCALAPPDATA%\GameWallDisplayHost\errors.log (kept under ~1 MB).</summary>
    public static void LogError(string where, Exception? ex)
    {
        try
        {
            lock (LogGate)
            {
                var path = LogPath;
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length > 1_000_000)
                    File.Move(path, path + ".old", overwrite: true);
                File.AppendAllText(path, $"{DateTime.Now:O} [{where}] {ex}{Environment.NewLine}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never be the thing that crashes the wall.
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _showWait?.Unregister(null);
        _showSignal?.Dispose();
        try { _singleInstance?.ReleaseMutex(); } catch (ApplicationException) { }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
