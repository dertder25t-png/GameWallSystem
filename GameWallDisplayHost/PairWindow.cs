using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using WpfButton = System.Windows.Controls.Button;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfFontFamily = System.Windows.Media.FontFamily;
using WpfHorizontalAlignment = System.Windows.HorizontalAlignment;
using WpfOrientation = System.Windows.Controls.Orientation;

namespace GameWallDisplayHost;

/// <summary>
/// Small always-on-top window that shows the 6-digit pairing code. Built in code
/// (no XAML) and styled like GameDay: black, white type, one primary button.
/// Closes itself a moment after a phone pairs.
/// </summary>
public sealed class PairWindow : Window
{
    private readonly CloudBridge _bridge;
    private readonly TextBlock _code = new();
    private readonly TextBlock _hint = new();
    private readonly TextBlock _status = new();
    private readonly WpfButton _newCode = new();
    private readonly DispatcherTimer _countdown = new() { Interval = TimeSpan.FromSeconds(1) };
    private DateTimeOffset _expiresAt;
    private bool _paired;

    public PairWindow(CloudBridge bridge, string? welcome = null)
    {
        _bridge = bridge;
        Title = "Pair your phone with GameWall";
        Width = 460;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Topmost = true;
        StayOffTaskbar.Apply(this);
        Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 0, 0));

        var font = new WpfFontFamily("Segoe UI");
        var text = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xF2, 0xF2, 0xF2));
        var muted = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x8B, 0x8B, 0x8B));

        var stack = new StackPanel { Margin = new Thickness(28, 24, 28, 24) };

        if (!string.IsNullOrWhiteSpace(welcome))
        {
            stack.Children.Add(new TextBlock
            {
                Text = welcome, Foreground = muted, FontFamily = font, FontSize = 13,
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 16),
            });
        }

        stack.Children.Add(new TextBlock
        {
            Text = "PAIR YOUR PHONE", Foreground = muted, FontFamily = font, FontSize = 12,
            FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 6),
        });
        stack.Children.Add(new TextBlock
        {
            Text = "On your phone, open GameDay → Wall → Pair, then enter:",
            Foreground = text, FontFamily = font, FontSize = 15, TextWrapping = TextWrapping.Wrap,
        });

        _code.Text = "······";
        _code.Foreground = text;
        _code.FontFamily = new WpfFontFamily("Consolas");
        _code.FontSize = 56;
        _code.FontWeight = FontWeights.Bold;
        _code.HorizontalAlignment = WpfHorizontalAlignment.Center;
        _code.Margin = new Thickness(0, 18, 0, 6);
        stack.Children.Add(_code);

        _hint.Foreground = muted;
        _hint.FontFamily = font;
        _hint.FontSize = 12;
        _hint.HorizontalAlignment = WpfHorizontalAlignment.Center;
        stack.Children.Add(_hint);

        _status.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3E, 0xCF, 0x6E));
        _status.FontFamily = font;
        _status.FontSize = 14;
        _status.TextWrapping = TextWrapping.Wrap;
        _status.Margin = new Thickness(0, 12, 0, 0);
        _status.HorizontalAlignment = WpfHorizontalAlignment.Center;
        stack.Children.Add(_status);

        var buttons = new StackPanel
        {
            Orientation = WpfOrientation.Horizontal,
            HorizontalAlignment = WpfHorizontalAlignment.Center,
            Margin = new Thickness(0, 18, 0, 0),
        };
        _newCode.Content = "New code";
        StyleButton(_newCode, primary: false, font);
        _newCode.Click += async (_, _) => await LoadCodeAsync();
        var done = new WpfButton { Content = "Done" };
        StyleButton(done, primary: true, font);
        done.Click += (_, _) => Close();
        buttons.Children.Add(_newCode);
        buttons.Children.Add(done);
        stack.Children.Add(buttons);

        Content = stack;

        _countdown.Tick += (_, _) => UpdateCountdown();
        _bridge.Paired += OnPaired;
        Loaded += async (_, _) => await LoadCodeAsync();
        Closed += (_, _) =>
        {
            _countdown.Stop();
            _bridge.Paired -= OnPaired;
        };
    }

    private static void StyleButton(WpfButton button, bool primary, WpfFontFamily font)
    {
        button.FontFamily = font;
        button.FontSize = 14;
        button.Padding = new Thickness(16, 8, 16, 8);
        button.Margin = new Thickness(6, 0, 6, 0);
        button.BorderThickness = new Thickness(1);
        button.Foreground = primary ? WpfBrushes.Black : new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xF2, 0xF2, 0xF2));
        button.Background = primary
            ? new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xF2, 0xF2, 0xF2))
            : new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x14, 0x14, 0x14));
        button.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x26, 0x26, 0x26));
    }

    private async Task LoadCodeAsync()
    {
        if (_paired) return;
        _newCode.IsEnabled = false;
        _hint.Text = "Getting a code…";
        _status.Text = "";
        try
        {
            var (code, expiresAt) = await _bridge.RequestPairingCodeAsync();
            _code.Text = code.Length == 6 ? $"{code[..3]} {code[3..]}" : code;
            _expiresAt = expiresAt;
            _countdown.Start();
            UpdateCountdown();
        }
        catch (Exception ex)
        {
            _code.Text = "------";
            _hint.Text = "Couldn't reach GameWall's server. Check the internet connection.";
            _status.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xFF, 0x5B, 0x5B));
            _status.Text = ex.Message;
        }
        finally
        {
            _newCode.IsEnabled = true;
        }
    }

    private void UpdateCountdown()
    {
        var left = _expiresAt - DateTimeOffset.UtcNow;
        if (left <= TimeSpan.Zero)
        {
            _countdown.Stop();
            _code.Text = "------";
            _hint.Text = "Code expired. Tap New code.";
            return;
        }
        _hint.Text = $"Works for {(int)left.TotalMinutes}:{left.Seconds:00} · one phone per code";
    }

    private void OnPaired(string phoneName)
    {
        Dispatcher.InvokeAsync(async () =>
        {
            _paired = true;
            _countdown.Stop();
            _code.Text = "✓";
            _hint.Text = "";
            _status.Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x3E, 0xCF, 0x6E));
            _status.Text = $"Paired with {phoneName}. You can control the wall from GameDay now.";
            await Task.Delay(2500);
            if (IsLoaded) Close();
        });
    }
}
