using System.Threading;
using System.Windows;

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

    protected override void OnStartup(StartupEventArgs e)
    {
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

    protected override void OnExit(ExitEventArgs e)
    {
        _showWait?.Unregister(null);
        _showSignal?.Dispose();
        try { _singleInstance?.ReleaseMutex(); } catch (ApplicationException) { }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
