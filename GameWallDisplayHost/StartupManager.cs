using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace GameWallDisplayHost;

/// <summary>"Start with Windows": a per-user Run key, no admin rights needed.</summary>
public static class StartupManager
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "GameWall";

    private static string Command => $"\"{Environment.ProcessPath}\" --background";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            return key?.GetValue(ValueName) is string value && value.Length > 0;
        }
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (enabled) key.SetValue(ValueName, Command);
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    /// <summary>Re-points the Run entry at this exe if it moved (e.g. after a rebuild into dist\).</summary>
    public static void RefreshPathIfEnabled()
    {
        if (!IsEnabled) return;
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        if (key?.GetValue(ValueName) as string != Command) key?.SetValue(ValueName, Command);
    }
}

/// <summary>Keeps the display on only while a game session is running.</summary>
public static class KeepAwake
{
    [Flags]
    private enum ExecutionState : uint
    {
        SystemRequired = 0x00000001,
        DisplayRequired = 0x00000002,
        Continuous = 0x80000000,
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern ExecutionState SetThreadExecutionState(ExecutionState flags);

    /// <summary>Call from the UI thread (the setting belongs to the calling thread).</summary>
    public static void Set(bool awake)
    {
        SetThreadExecutionState(awake
            ? ExecutionState.Continuous | ExecutionState.SystemRequired | ExecutionState.DisplayRequired
            : ExecutionState.Continuous);
    }
}
