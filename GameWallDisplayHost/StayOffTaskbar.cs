using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace GameWallDisplayHost;

/// <summary>
/// Keeps GameWall's windows off the taskbar and out of Alt+Tab, so the only trace of
/// GameWall on the laptop is the tray icon (and the wall itself while a session runs).
/// </summary>
public static class StayOffTaskbar
{
    private const int GwlExStyle = -20;
    private const long WsExToolWindow = 0x00000080;
    private const long WsExAppWindow = 0x00040000;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    /// <summary>Call from the window's constructor, before it is first shown.</summary>
    public static void Apply(Window window)
    {
        window.ShowInTaskbar = false;
        window.SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            var style = GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
            style = (style | WsExToolWindow) & ~WsExAppWindow;
            SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(style));
        };
    }
}
