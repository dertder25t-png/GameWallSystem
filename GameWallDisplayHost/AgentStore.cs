using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameWallDisplayHost;

/// <summary>
/// Where the agent keeps its settings and its cloud identity.
/// Stored in %LocalAppData%\GameWallDisplayHost\agent.json. The device secret and
/// signing key are encrypted with Windows DPAPI (tied to the Windows user), so copying
/// the file to another account or machine does not let anyone impersonate this laptop.
/// </summary>
public sealed class AgentSettings
{
    // Cloud identity (null until the laptop registers the first time).
    public string? DeviceId { get; set; }
    public string? DeviceSecretProtected { get; set; }
    public string? SignKeyProtected { get; set; }
    public string? CommandTopic { get; set; }
    public string? StateTopic { get; set; }
    public string DeviceName { get; set; } = Environment.MachineName;

    // Local behaviour.
    /// <summary>When false (default) the local remote on port 5000 only accepts this PC.</summary>
    public bool LanRemote { get; set; }
    /// <summary>Set once the first-run welcome (start with Windows + pairing) has been shown.</summary>
    public bool FirstRunDone { get; set; }

    public bool HasIdentity =>
        !string.IsNullOrWhiteSpace(DeviceId) &&
        !string.IsNullOrWhiteSpace(DeviceSecretProtected) &&
        !string.IsNullOrWhiteSpace(SignKeyProtected) &&
        !string.IsNullOrWhiteSpace(CommandTopic) &&
        !string.IsNullOrWhiteSpace(StateTopic);
}

public static class AgentStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private static readonly object Gate = new();

    public static string Folder { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GameWallDisplayHost");

    public static string FilePath => Path.Combine(Folder, "agent.json");

    public static AgentSettings Load()
    {
        lock (Gate)
        {
            try
            {
                if (File.Exists(FilePath))
                    return JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(FilePath)) ?? new AgentSettings();
            }
            catch
            {
                // A corrupt file just means we register again.
            }
            return new AgentSettings();
        }
    }

    public static void Save(AgentSettings settings)
    {
        lock (Gate)
        {
            Directory.CreateDirectory(Folder);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(settings, JsonOptions));
            File.Move(tmp, FilePath, overwrite: true);
        }
    }

    public static string Protect(string plain)
    {
        var bytes = Encoding.UTF8.GetBytes(plain);
#if WINDOWS
        bytes = ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser);
#endif
        return Convert.ToBase64String(bytes);
    }

    public static string? Unprotect(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored)) return null;
        try
        {
            var bytes = Convert.FromBase64String(stored);
#if WINDOWS
            bytes = ProtectedData.Unprotect(bytes, Entropy, DataProtectionScope.CurrentUser);
#endif
            return Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return null;
        }
    }

#if WINDOWS
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("GameWall agent v1");
#endif
}
