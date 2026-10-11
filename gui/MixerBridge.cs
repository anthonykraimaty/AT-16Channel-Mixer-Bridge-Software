// Mixer Bridge, the window: starts the bridge (server\index.js) without a
// console, shows how things stand and lives in the tray when closed.
// Built with the C# compiler that comes with Windows, see build.bat.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Mixer Bridge")]
[assembly: AssemblyProduct("Mixer Bridge")]
[assembly: AssemblyVersion("1.0.0.0")]

static class Program
{
    public const string ShowSignal = "MixerBridge.Show";
    public const string ShotSignal = "MixerBridge.Snapshot";

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    public static string ShotNote { get { return Path.Combine(Path.GetTempPath(), "mixerbridge-snapshot.txt"); } }

    static string Arg(string[] args, string name)
    {
        int at = Array.IndexOf(args, name);
        return at >= 0 && at + 1 < args.Length ? args[at + 1] : null;
    }

    static bool Raise(string name)
    {
        try
        {
            using (EventWaitHandle signal = EventWaitHandle.OpenExisting(name)) signal.Set();
            return true;
        }
        catch { return false; }
    }

    [STAThread]
    static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Look.Load();

        // Used by build.bat: the program draws its own icon.
        string icon = Arg(args, "--make-icon");
        if (icon != null) { Art.WriteIco(icon); return 0; }

        // For checking the tray icons: all of them on one sheet, enlarged.
        string sheet = Arg(args, "--tray-preview");
        if (sheet != null) { Art.WriteSheet(sheet); return 0; }

        // For checking the codes: the code for a text, as a picture.
        string code = Arg(args, "--qr-test");
        if (code != null && args.Length >= 3) { Qr.WritePicture(code, args[args.Length - 1]); return 0; }

        // For checking the window: asks the running program for a picture of itself.
        string shot = Arg(args, "--snapshot");
        if (shot != null)
        {
            File.WriteAllText(ShotNote, Path.GetFullPath(shot));
            return Raise(ShotSignal) ? 0 : 1;
        }

        bool first;
        using (Mutex one = new Mutex(true, "MixerBridge.Window", out first))
        {
            if (!first) { Raise(ShowSignal); return 0; }
            Application.Run(new MainForm(Array.IndexOf(args, "--tray") >= 0));
        }
        return 0;
    }
}

// --- colours, type and drawing helpers ---------------------------------------
static class Look
{
    public static readonly Color Bg = Hex("0d0e10");
    public static readonly Color Panel = Hex("15171a");
    public static readonly Color Panel2 = Hex("1b1e22");
    public static readonly Color Raised = Hex("24282d");
    public static readonly Color Line = Hex("2a2e34");
    public static readonly Color Edge = Hex("3a3f46");
    public static readonly Color Ink = Hex("f2efe8");
    public static readonly Color Dim = Hex("8d939b");
    public static readonly Color Faint = Hex("5b6169");
    public static readonly Color Amber = Hex("ffb000");
    public static readonly Color Red = Hex("ff4d4f");
    public static readonly Color Green = Hex("3ddc84");

    public static float Scale = 1f;
    public static StringFormat Plain;
    public static StringFormat Wrapped;

    static readonly PrivateFontCollection Bundled = new PrivateFontCollection();
    static readonly Dictionary<string, Font> Fonts = new Dictionary<string, Font>();
    static FontFamily label, body, medium, mono;

    public static Color Hex(string hex)
    {
        return Color.FromArgb(Convert.ToInt32(hex.Substring(0, 2), 16), Convert.ToInt32(hex.Substring(2, 2), 16), Convert.ToInt32(hex.Substring(4, 2), 16));
    }

    public static Color Blend(Color a, Color b, float t)
    {
        return Color.FromArgb((int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
    }

    public static int S(float v) { return (int)Math.Round(v * Scale); }

    public static void Load()
    {
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) Scale = g.DpiX / 96f;

        Plain = new StringFormat(StringFormat.GenericTypographic);
        Plain.FormatFlags |= StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces;
        Plain.Trimming = StringTrimming.EllipsisCharacter;
        Wrapped = new StringFormat(StringFormat.GenericTypographic);

        // The same faces as the mixer interface, carried inside the program.
        Assembly self = Assembly.GetExecutingAssembly();
        foreach (string name in self.GetManifestResourceNames())
        {
            if (!name.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                using (Stream s = self.GetManifestResourceStream(name))
                {
                    byte[] data = new byte[s.Length];
                    s.Read(data, 0, data.Length);
                    // Stays allocated: the font is read from this memory for as long as we run.
                    IntPtr mem = Marshal.AllocCoTaskMem(data.Length);
                    Marshal.Copy(data, 0, mem, data.Length);
                    Bundled.AddMemoryFont(mem, data.Length);
                }
            }
            catch { }
        }
        label = Family("Barlow Condensed SemiBold", "Segoe UI Semibold");
        body = Family("Barlow", "Segoe UI");
        medium = Family("Barlow Medium", "Segoe UI Semibold");
        mono = Family(null, "Consolas");
    }

    static FontFamily Family(string bundled, string fallback)
    {
        if (bundled != null)
        {
            foreach (FontFamily f in Bundled.Families) if (f.Name == bundled) return f;
        }
        try { return new FontFamily(fallback); } catch { return FontFamily.GenericSansSerif; }
    }

    static Font Make(FontFamily family, float px)
    {
        string key = family.Name + "/" + px;
        Font font;
        if (Fonts.TryGetValue(key, out font)) return font;
        FontStyle style = family.IsStyleAvailable(FontStyle.Regular) ? FontStyle.Regular : FontStyle.Bold;
        font = new Font(family, px * Scale, style, GraphicsUnit.Pixel);
        Fonts[key] = font;
        return font;
    }

    public static Font Label(float px) { return Make(label, px); }
    public static Font Body(float px) { return Make(body, px); }
    public static Font Medium(float px) { return Make(medium, px); }
    public static Font Mono(float px) { return Make(mono, px); }

    public static void Prepare(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    }

    public static GraphicsPath Round(RectangleF r, float radius)
    {
        float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        GraphicsPath p = new GraphicsPath();
        if (d <= 0) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static void Write(Graphics g, string text, Font font, Color color, float x, float y, float width)
    {
        using (SolidBrush b = new SolidBrush(color))
            g.DrawString(text ?? "", font, b, new RectangleF(x, y, width, font.GetHeight(g) + 2), Plain);
    }

    public static float Width(Graphics g, string text, Font font)
    {
        return g.MeasureString(text ?? "", font, 10000, Plain).Width;
    }

    // Letter-spaced capitals, as on the labels of the mixer interface.
    public static float TrackedWidth(Graphics g, string text, Font font, float tracking)
    {
        float w = 0;
        foreach (char c in text) w += g.MeasureString(c.ToString(), font, 1000, Plain).Width + tracking;
        return text.Length > 0 ? w - tracking : 0;
    }

    public static void Tracked(Graphics g, string text, Font font, Color color, float x, float y, float tracking)
    {
        using (SolidBrush b = new SolidBrush(color))
        {
            foreach (char c in text)
            {
                string one = c.ToString();
                g.DrawString(one, font, b, x, y, Plain);
                x += g.MeasureString(one, font, 1000, Plain).Width + tracking;
            }
        }
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public static void DarkFrame(IntPtr handle)
    {
        int on = 1;
        try { if (DwmSetWindowAttribute(handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(handle, 19, ref on, 4); } catch { }
    }
}

// --- the icon, drawn rather than stored ---------------------------------------
static class Art
{
    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr handle);

    public static void Draw(Graphics g, float size, Color? lamp)
    {
        GraphicsState before = g.Save();
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.ScaleTransform(size / 64f, size / 64f);
        bool small = size < 28;

        using (GraphicsPath p = Look.Round(new RectangleF(0, 0, 64, 64), 14))
        using (SolidBrush b = new SolidBrush(Look.Bg))
            g.FillPath(b, p);
        if (small)
        {
            using (GraphicsPath p = Look.Round(new RectangleF(1.5f, 1.5f, 61, 61), 13))
            using (Pen edge = new Pen(Look.Edge, 3))
                g.DrawPath(edge, p);
        }
        using (Pen rail = new Pen(Look.Hex(small ? "3a3f46" : "2c3036"), small ? 4 : 3))
        {
            rail.StartCap = LineCap.Round;
            rail.EndCap = LineCap.Round;
            foreach (int x in new int[] { 18, 32, 46 }) g.DrawLine(rail, x, 12, x, 52);
        }
        float h = small ? 12 : 9, w = small ? 15 : 14;
        float[] tops = { 34, 18, 27 };
        for (int i = 0; i < 3; i++)
        {
            float cx = 18 + 14 * i;
            using (GraphicsPath p = Look.Round(new RectangleF(cx - w / 2, tops[i] + 4.5f - h / 2, w, h), 2))
            using (SolidBrush b = new SolidBrush(i == 1 ? Look.Amber : Look.Ink))
                g.FillPath(b, p);
        }
        if (lamp.HasValue)
        {
            using (SolidBrush ring = new SolidBrush(Look.Bg)) g.FillEllipse(ring, 32, 32, 34, 34);
            using (SolidBrush dot = new SolidBrush(lamp.Value)) g.FillEllipse(dot, 37, 37, 24, 24);
        }
        g.Restore(before);
    }

    public static Bitmap Picture(int size, Color? lamp)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            Draw(g, size, lamp);
        }
        return bmp;
    }

    public static Icon Tray(Color lamp)
    {
        using (Bitmap bmp = Picture(SystemInformation.SmallIconSize.Width, lamp))
        {
            IntPtr handle = bmp.GetHicon();
            try
            {
                using (Icon borrowed = Icon.FromHandle(handle)) return (Icon)borrowed.Clone();
            }
            finally { DestroyIcon(handle); }
        }
    }

    public static void WriteSheet(string file)
    {
        int[] sizes = { 16, 20, 24, 32 };
        Color[] lamps = { Look.Green, Look.Amber, Look.Red, Look.Faint };
        using (Bitmap sheet = new Bitmap(4 * 140, 4 * 140))
        using (Graphics g = Graphics.FromImage(sheet))
        {
            g.Clear(Look.Hex("1c1c1c"));
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            for (int row = 0; row < sizes.Length; row++)
                for (int col = 0; col < lamps.Length; col++)
                    using (Bitmap one = Picture(sizes[row], lamps[col]))
                        g.DrawImage(one, new Rectangle(col * 140 + 6, row * 140 + 6, sizes[row] * 4, sizes[row] * 4));
            sheet.Save(file, ImageFormat.Png);
        }
    }

    public static void WriteIco(string file)
    {
        int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 256 };
        List<byte[]> images = new List<byte[]>();
        foreach (int size in sizes)
        {
            using (Bitmap bmp = Picture(size, null))
                images.Add(size >= 256 ? Png(bmp) : Dib(bmp));
        }
        using (FileStream fs = File.Create(file))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                w.Write((byte)0); w.Write((byte)0);
                w.Write((short)1); w.Write((short)32);
                w.Write(images[i].Length);
                w.Write(offset);
                offset += images[i].Length;
            }
            foreach (byte[] image in images) w.Write(image);
        }
    }

    static byte[] Png(Bitmap bmp)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    // The older picture format inside icons: rows bottom-up, then an (empty) mask.
    static byte[] Dib(Bitmap bmp)
    {
        int n = bmp.Width;
        BitmapData data = bmp.LockBits(new Rectangle(0, 0, n, n), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] pixels = new byte[n * n * 4];
        for (int y = 0; y < n; y++)
            Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), pixels, (n - 1 - y) * n * 4, n * 4);
        bmp.UnlockBits(data);
        int maskRow = ((n + 31) / 32) * 4;
        using (MemoryStream ms = new MemoryStream())
        using (BinaryWriter w = new BinaryWriter(ms))
        {
            w.Write(40); w.Write(n); w.Write(n * 2);
            w.Write((short)1); w.Write((short)32);
            w.Write(0); w.Write(pixels.Length + maskRow * n);
            w.Write(0); w.Write(0); w.Write(0); w.Write(0);
            w.Write(pixels);
            w.Write(new byte[maskRow * n]);
            w.Flush();
            return ms.ToArray();
        }
    }
}

// --- controls -------------------------------------------------------------------
enum BtnKind { Primary, Plain, Quiet, Danger }

sealed class Btn : Control
{
    public BtnKind Kind = BtnKind.Plain;
    public Color Under = Look.Bg;
    public float TextSize = 15;
    bool hover, down, keyboard;

    public Btn(string text, BtnKind kind, Color under)
    {
        Text = text;
        Kind = kind;
        Under = under;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, false);
        Cursor = Cursors.Hand;
    }

    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
    protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { keyboard = false; Invalidate(); base.OnLostFocus(e); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { down = true; keyboard = false; Focus(); Invalidate(); }
        base.OnMouseDown(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        bool fire = down && e.Button == MouseButtons.Left && ClientRectangle.Contains(e.Location);
        down = false;
        Invalidate();
        base.OnMouseUp(e);
        if (fire) OnClick(EventArgs.Empty);
    }

    protected override bool IsInputKey(Keys key) { return key == Keys.Enter || key == Keys.Space || base.IsInputKey(key); }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space) { e.Handled = true; OnClick(EventArgs.Empty); }
        base.OnKeyDown(e);
    }

    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Tab) { keyboard = true; Invalidate(); }
        base.OnKeyUp(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Under);
        Color fill, ink, edge;
        if (Kind == BtnKind.Primary)
        {
            fill = down ? Look.Hex("d99600") : hover ? Look.Hex("ffc23d") : Look.Amber;
            ink = Look.Hex("1a1300");
            edge = fill;
        }
        else if (Kind == BtnKind.Danger)
        {
            fill = down ? Look.Hex("d63c3e") : hover ? Look.Hex("ff6a6c") : Look.Red;
            ink = Look.Hex("1d0506");
            edge = fill;
        }
        else if (Kind == BtnKind.Plain)
        {
            fill = down ? Look.Panel2 : hover ? Look.Hex("2e3339") : Look.Raised;
            ink = Look.Ink;
            edge = Look.Edge;
        }
        else
        {
            fill = down ? Look.Panel2 : hover ? Look.Raised : Under;
            ink = hover ? Look.Ink : Look.Hex("b4bac3");
            edge = Look.Edge;
        }
        if (!Enabled)
        {
            fill = Look.Blend(fill, Under, 0.72f);
            ink = Look.Blend(ink, Under, 0.6f);
            edge = Look.Blend(edge, Under, 0.6f);
        }
        RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1, Height - 1);
        using (GraphicsPath p = Look.Round(r, Look.S(7)))
        {
            using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, p);
            using (Pen pen = new Pen(edge, 1)) g.DrawPath(pen, p);
        }
        if (Focused && keyboard)
        {
            using (GraphicsPath p = Look.Round(new RectangleF(2.5f, 2.5f, Width - 5, Height - 5), Look.S(5)))
            using (Pen pen = new Pen(Kind == BtnKind.Primary ? Look.Hex("1a1300") : Look.Amber, 1.5f))
                g.DrawPath(pen, p);
        }
        Font font = Look.Label(TextSize);
        string text = Text.ToUpperInvariant();
        float tracking = Look.Scale * 0.7f;
        float w = Look.TrackedWidth(g, text, font, tracking);
        Look.Tracked(g, text, font, ink, (Width - w) / 2f, (Height - font.GetHeight(g)) / 2f, tracking);
    }
}

sealed class Tick : Control
{
    bool on, hover;
    public event EventHandler Changed;

    public Tick(string text)
    {
        Text = text;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        Cursor = Cursors.Hand;
    }

    public bool On
    {
        get { return on; }
        set { on = value; Invalidate(); }
    }

    void Flip()
    {
        on = !on;
        Invalidate();
        if (Changed != null) Changed(this, EventArgs.Empty);
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseUp(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { Focus(); Flip(); } base.OnMouseUp(e); }
    protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { e.Handled = true; Flip(); } base.OnKeyDown(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Bg);
        float box = Look.S(18);
        RectangleF r = new RectangleF(0.5f, (Height - box) / 2f, box, box);
        using (GraphicsPath p = Look.Round(r, Look.S(4)))
        {
            using (SolidBrush b = new SolidBrush(on ? Look.Amber : hover ? Look.Raised : Look.Panel2)) g.FillPath(b, p);
            using (Pen pen = new Pen(on ? Look.Amber : Look.Edge, 1)) g.DrawPath(pen, p);
        }
        if (on)
        {
            using (Pen pen = new Pen(Look.Hex("1a1300"), Look.Scale * 2f))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
                g.DrawLines(pen, new PointF[] {
                    new PointF(r.X + box * 0.24f, r.Y + box * 0.52f),
                    new PointF(r.X + box * 0.43f, r.Y + box * 0.70f),
                    new PointF(r.X + box * 0.77f, r.Y + box * 0.32f) });
            }
        }
        Font font = Look.Body(13.5f);
        Look.Write(g, Text, font, hover || on ? Look.Ink : Look.Hex("b4bac3"), box + Look.S(10), (Height - font.GetHeight(g)) / 2f, Width - box - Look.S(10));
    }
}

sealed class LogView : Control
{
    struct Entry { public string Time, Text; public Color Color; }
    readonly List<Entry> lines = new List<Entry>();
    int back;

    public LogView()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    public void Add(string text, Color color)
    {
        Entry e = new Entry();
        e.Time = DateTime.Now.ToString("HH:mm:ss");
        e.Text = text;
        e.Color = color;
        lines.Add(e);
        if (lines.Count > 500) lines.RemoveRange(0, 100);
        back = 0;
        Invalidate();
    }

    public string All()
    {
        StringBuilder sb = new StringBuilder();
        foreach (Entry e in lines) sb.Append(e.Time).Append("  ").AppendLine(e.Text);
        return sb.ToString();
    }

    int RowHeight { get { return Look.S(18); } }
    int Rows { get { return Math.Max(1, (Height - Look.S(16)) / RowHeight); } }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        back = Math.Max(0, Math.Min(Math.Max(0, lines.Count - Rows), back + Math.Sign(e.Delta) * 3));
        Invalidate();
        base.OnMouseWheel(e);
    }

    protected override void OnMouseEnter(EventArgs e) { Focus(); base.OnMouseEnter(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Bg);
        using (GraphicsPath p = Look.Round(new RectangleF(0.5f, 0.5f, Width - 1, Height - 1), Look.S(8)))
        {
            using (SolidBrush b = new SolidBrush(Look.Hex("0a0b0c"))) g.FillPath(b, p);
            using (Pen pen = new Pen(Look.Line, 1)) g.DrawPath(pen, p);
        }
        Font font = Look.Mono(12);
        int rows = Rows;
        float letter = Look.Width(g, "00000000", font) / 8f;
        float timeWidth = letter * 8 + Look.S(12);
        float room = Width - timeWidth - Look.S(24);
        int fit = Math.Max(8, (int)(room / letter));

        // From the newest line upward, until the box is full.
        List<Entry> shown = new List<Entry>();
        for (int i = lines.Count - 1 - back; i >= 0 && shown.Count < rows; i--)
        {
            string text = lines[i].Text;
            List<Entry> parts = new List<Entry>();
            for (int at = 0; at < text.Length || at == 0; at += fit)
            {
                Entry part = new Entry();
                part.Time = at == 0 ? lines[i].Time : "";
                part.Text = text.Substring(at, Math.Min(fit, text.Length - at));
                part.Color = lines[i].Color;
                parts.Add(part);
                if (text.Length == 0) break;
            }
            for (int k = parts.Count - 1; k >= 0 && shown.Count < rows; k--) shown.Add(parts[k]);
        }
        float y = Look.S(8);
        for (int i = shown.Count - 1; i >= 0; i--)
        {
            if (shown[i].Time.Length > 0) Look.Write(g, shown[i].Time, font, Look.Faint, Look.S(12), y, timeWidth);
            Look.Write(g, shown[i].Text, font, shown[i].Color, Look.S(12) + timeWidth, y, room + letter);
            y += RowHeight;
        }
        if (lines.Count == 0) Look.Write(g, "Nothing yet.", font, Look.Faint, Look.S(12), y, Width);
    }
}

sealed class MenuColors : ProfessionalColorTable
{
    public override Color ToolStripDropDownBackground { get { return Look.Panel2; } }
    public override Color MenuBorder { get { return Look.Edge; } }
    public override Color MenuItemBorder { get { return Look.Raised; } }
    public override Color MenuItemSelected { get { return Look.Raised; } }
    public override Color MenuItemSelectedGradientBegin { get { return Look.Raised; } }
    public override Color MenuItemSelectedGradientEnd { get { return Look.Raised; } }
    public override Color ImageMarginGradientBegin { get { return Look.Panel2; } }
    public override Color ImageMarginGradientMiddle { get { return Look.Panel2; } }
    public override Color ImageMarginGradientEnd { get { return Look.Panel2; } }
    public override Color SeparatorDark { get { return Look.Line; } }
    public override Color SeparatorLight { get { return Look.Panel2; } }
}

// A question or a single line to fill in, in the look of the rest.
sealed class Dialog : Form
{
    readonly string title, message;
    readonly TextBox box;
    readonly int textTop;

    public string Value { get { return box == null ? null : box.Text.Trim(); } }

    public Dialog(string title, string message, string ok, string cancel, string input, bool danger)
    {
        this.title = title;
        this.message = message;
        Text = "Mixer Bridge";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ShowIcon = false;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Look.Panel;
        DoubleBuffered = true;
        KeyPreview = true;

        int width = Look.S(420), pad = Look.S(22);
        float textHeight;
        using (Graphics g = CreateGraphics())
            textHeight = g.MeasureString(message, Look.Body(14), width - pad * 2, Look.Wrapped).Height;
        textTop = Look.S(56);
        int y = textTop + (int)Math.Ceiling(textHeight) + Look.S(18);

        if (input != null)
        {
            box = new TextBox();
            box.Text = input;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.BackColor = Look.Bg;
            box.ForeColor = Look.Ink;
            box.Font = new Font("Consolas", 16 * Look.Scale, FontStyle.Regular, GraphicsUnit.Pixel);
            box.SetBounds(pad, y, width - pad * 2, Look.S(30));
            Controls.Add(box);
            y += box.Height + Look.S(20);
        }

        Btn yes = new Btn(ok, danger ? BtnKind.Danger : BtnKind.Primary, Look.Panel);
        Btn no = new Btn(cancel, BtnKind.Plain, Look.Panel);
        int bw = Look.S(128), bh = Look.S(38);
        yes.SetBounds(width - pad - bw, y, bw, bh);
        no.SetBounds(width - pad - bw * 2 - Look.S(10), y, bw, bh);
        yes.Click += delegate { DialogResult = DialogResult.OK; };
        no.Click += delegate { DialogResult = DialogResult.Cancel; };
        Controls.Add(no);
        Controls.Add(yes);
        ClientSize = new Size(width, y + bh + pad);
        if (box != null) { box.TabIndex = 0; ActiveControl = box; box.SelectAll(); }
        else ActiveControl = no;
    }

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Look.DarkFrame(Handle); }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape) { e.Handled = true; DialogResult = DialogResult.Cancel; }
        else if (e.KeyCode == Keys.Enter && box != null && box.Focused) { e.Handled = true; e.SuppressKeyPress = true; DialogResult = DialogResult.OK; }
        base.OnKeyDown(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Panel);
        int pad = Look.S(22);
        Look.Tracked(g, title.ToUpperInvariant(), Look.Label(21), Look.Ink, pad, Look.S(20), Look.Scale * 0.8f);
        using (SolidBrush b = new SolidBrush(Look.Hex("b4bac3")))
            g.DrawString(message, Look.Body(14), b, new RectangleF(pad, textTop, ClientSize.Width - pad * 2, ClientSize.Height), Look.Wrapped);
    }

    public static bool Ask(Form owner, string title, string message, string ok, string cancel, bool danger)
    {
        using (Dialog d = new Dialog(title, message, ok, cancel, null, danger)) return Run(d, owner) == DialogResult.OK;
    }

    public static string Fill(Form owner, string title, string message, string ok, string value)
    {
        using (Dialog d = new Dialog(title, message, ok, "Cancel", value, false))
            return Run(d, owner) == DialogResult.OK ? d.Value : null;
    }

    static DialogResult Run(Dialog d, Form owner)
    {
        if (owner != null && owner.Visible && owner.WindowState != FormWindowState.Minimized)
        {
            d.StartPosition = FormStartPosition.CenterParent;
            return d.ShowDialog(owner);
        }
        d.StartPosition = FormStartPosition.CenterScreen;
        d.TopMost = true;
        return d.ShowDialog();
    }
}

// One mixer that the search came across.
sealed class Pick : Control
{
    public string Note = "";
    public bool Sure = true, Chosen;
    bool hover;

    public Pick(string address)
    {
        Text = address;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, false);
        Cursor = Cursors.Hand;
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button == MouseButtons.Left && ClientRectangle.Contains(e.Location)) OnClick(EventArgs.Empty);
    }
    protected override bool IsInputKey(Keys key) { return key == Keys.Enter || key == Keys.Space || base.IsInputKey(key); }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter || e.KeyCode == Keys.Space) { e.Handled = true; OnClick(EventArgs.Empty); }
        base.OnKeyDown(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Panel);
        using (GraphicsPath p = Look.Round(new RectangleF(0.5f, 0.5f, Width - 1, Height - 1), Look.S(7)))
        {
            using (SolidBrush b = new SolidBrush(hover ? Look.Raised : Look.Panel2)) g.FillPath(b, p);
            using (Pen pen = new Pen(Chosen ? Look.Amber : Focused ? Look.Edge : Look.Line, 1)) g.DrawPath(pen, p);
        }
        float mid = Height / 2f;
        using (SolidBrush b = new SolidBrush(Sure ? Look.Green : Look.Amber)) g.FillEllipse(b, Look.S(14), mid - Look.S(4), Look.S(8), Look.S(8));
        Font mono = Look.Mono(15);
        Look.Write(g, Text, mono, Look.Ink, Look.S(32), mid - mono.GetHeight(g) / 2f, Width);
        Font body = Look.Medium(13);
        float w = Look.Width(g, Note, body);
        Look.Write(g, Note, body, Sure ? Look.Hex("b4bac3") : Look.Amber, Width - Look.S(14) - w, mid - body.GetHeight(g) / 2f, w + Look.S(4));
    }
}

// The mixer's address: typed, or found by searching the network.
sealed class AddressDialog : Form
{
    const int Rows = 3;
    readonly string current, root, node, message;
    readonly TextBox box;
    readonly Btn scanBtn;
    readonly List<Pick> picks = new List<Pick>();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly int textTop, listTop, width, pad;
    Process scanner;
    string status = "Scan looks for the mixer on the networks of this computer.";
    Color statusColor = Look.Dim;
    float progress = -1;
    int more;

    public string Value { get { return box.Text.Trim(); } }

    public AddressDialog(string current, string root, string node, bool restarts)
    {
        this.current = current;
        this.root = root;
        this.node = node;
        message = "Type the address of the mixer, or let Scan look for it." + (restarts ? " The bridge restarts to use it." : "");
        Text = "Mixer Bridge";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ShowIcon = false;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Look.Panel;
        DoubleBuffered = true;
        KeyPreview = true;

        width = Look.S(440);
        pad = Look.S(22);
        float textHeight;
        using (Graphics g = CreateGraphics())
            textHeight = g.MeasureString(message, Look.Body(14), width - pad * 2, Look.Wrapped).Height;
        textTop = Look.S(56);
        int y = textTop + (int)Math.Ceiling(textHeight) + Look.S(18);

        int scanWidth = Look.S(104);
        box = new TextBox();
        box.Text = current;
        box.BorderStyle = BorderStyle.FixedSingle;
        box.BackColor = Look.Bg;
        box.ForeColor = Look.Ink;
        box.Font = new Font("Consolas", 16 * Look.Scale, FontStyle.Regular, GraphicsUnit.Pixel);
        box.SetBounds(pad, y + Look.S(3), width - pad * 2 - scanWidth - Look.S(10), Look.S(30));
        box.TextChanged += delegate { Mark(); };
        Controls.Add(box);

        scanBtn = new Btn("Scan", BtnKind.Plain, Look.Panel);
        scanBtn.SetBounds(width - pad - scanWidth, y, scanWidth, box.Height + Look.S(6));
        scanBtn.Enabled = node != null && root != null;
        scanBtn.Click += delegate { if (scanner == null) Search(); else Halt("Search stopped."); };
        Controls.Add(scanBtn);

        listTop = scanBtn.Bottom + Look.S(44);
        y = listTop + Rows * Look.S(44) + Look.S(10);

        Btn yes = new Btn("Use it", BtnKind.Primary, Look.Panel);
        Btn no = new Btn("Cancel", BtnKind.Plain, Look.Panel);
        int bw = Look.S(128), bh = Look.S(38);
        yes.SetBounds(width - pad - bw, y, bw, bh);
        no.SetBounds(width - pad - bw * 2 - Look.S(10), y, bw, bh);
        yes.Click += delegate { DialogResult = DialogResult.OK; };
        no.Click += delegate { DialogResult = DialogResult.Cancel; };
        Controls.Add(no);
        Controls.Add(yes);
        ClientSize = new Size(width, y + bh + pad);
        ActiveControl = box;
        box.SelectAll();
    }

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Look.DarkFrame(Handle); }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape) { e.Handled = true; DialogResult = DialogResult.Cancel; }
        else if (e.KeyCode == Keys.Enter && box.Focused) { e.Handled = true; e.SuppressKeyPress = true; DialogResult = DialogResult.OK; }
        base.OnKeyDown(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        Halt(null);
        base.OnFormClosed(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Panel);
        Look.Tracked(g, "MIXER ADDRESS", Look.Label(21), Look.Ink, pad, Look.S(20), Look.Scale * 0.8f);
        using (SolidBrush b = new SolidBrush(Look.Hex("b4bac3")))
            g.DrawString(message, Look.Body(14), b, new RectangleF(pad, textTop, width - pad * 2, listTop - textTop), Look.Wrapped);

        int line = listTop - Look.S(30);
        Look.Write(g, status + (more > 0 ? "  (" + more + " more not shown)" : ""), Look.Body(13), statusColor, pad, line, width - pad * 2);
        if (progress >= 0)
        {
            RectangleF rail = new RectangleF(pad, listTop - Look.S(9), width - pad * 2, Look.S(3));
            using (SolidBrush b = new SolidBrush(Look.Line)) g.FillRectangle(b, rail);
            using (SolidBrush b = new SolidBrush(Look.Amber)) g.FillRectangle(b, rail.X, rail.Y, rail.Width * Math.Min(1f, progress), rail.Height);
        }
    }

    void Tell(string text, Color color)
    {
        status = text;
        statusColor = color;
        Invalidate();
    }

    // The row whose address stands in the box is the chosen one.
    void Mark()
    {
        foreach (Pick p in picks)
        {
            bool chosen = p.Text == Value;
            if (p.Chosen != chosen) { p.Chosen = chosen; p.Invalidate(); }
        }
    }

    void Search()
    {
        foreach (Pick old in picks) { Controls.Remove(old); old.Dispose(); }
        picks.Clear();
        more = 0;
        string prefer = Regex.IsMatch(current ?? "", @"^\d+\.\d+\.\d+\.\d+$") ? " --prefer " + current : "";
        ProcessStartInfo info = new ProcessStartInfo(node, "server\\scan.js" + prefer);
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        Process p = new Process();
        p.StartInfo = info;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
        {
            string line = e.Data;
            if (string.IsNullOrEmpty(line)) return;
            try { BeginInvoke((MethodInvoker)delegate { if (p == scanner) Heard(line); }); } catch { }
        };
        p.Exited += delegate
        {
            try { BeginInvoke((MethodInvoker)delegate { if (p == scanner) Ended(); }); } catch { }
        };
        try { p.Start(); }
        catch (Exception err)
        {
            Tell("Could not search: " + err.Message, Look.Red);
            return;
        }
        Leash.Hold(p);
        scanner = p;
        p.BeginOutputReadLine();
        progress = 0;
        scanBtn.Text = "Stop";
        Tell("Searching...", Look.Dim);
    }

    void Heard(string line)
    {
        Dictionary<string, object> m;
        try { m = json.Deserialize<Dictionary<string, object>>(line); } catch { return; }
        if (m == null || !m.ContainsKey("t")) return;
        string kind = Convert.ToString(m["t"]);
        if (kind == "network")
        {
            if (picks.Count == 0) Tell("Searching " + m["from"] + " to " + m["to"] + "...", Look.Dim);
        }
        else if (kind == "progress")
        {
            progress = Convert.ToSingle(m["done"]) / Math.Max(1f, Convert.ToSingle(m["total"]));
            Invalidate();
        }
        else if (kind == "found")
        {
            Found(Convert.ToString(m["address"]), Convert.ToString(m["model"]), Convert.ToBoolean(m["sure"]));
        }
        else if (kind == "error")
        {
            Tell("Could not search: " + m["message"], Look.Red);
        }
    }

    void Found(string address, string model, bool sure)
    {
        if (picks.Count >= Rows) { more++; Invalidate(); return; }
        Pick pick = new Pick(address);
        pick.Sure = sure;
        pick.Note = sure ? (model.Length > 0 ? model : "Mixer") + (address == current ? ", in use now" : "")
                         : "Does not answer: connections all taken?";
        pick.SetBounds(pad, listTop + picks.Count * Look.S(44), width - pad * 2, Look.S(38));
        pick.Click += delegate { box.Text = pick.Text; Mark(); };
        picks.Add(pick);
        Controls.Add(pick);
        Mark();
        Tell(picks.Count == 1 ? "Found one. Still searching..." : "Found " + picks.Count + ". Still searching...", Look.Dim);
    }

    void Ended()
    {
        Release();
        if (statusColor == Look.Red) return;
        int sure = 0;
        Pick only = null;
        foreach (Pick p in picks) if (p.Sure) { sure++; only = p; }
        if (picks.Count == 0) Tell("No mixer found. Is it switched on, and on the same network?", Look.Amber);
        else if (sure == 1)
        {
            // Only one mixer around: that must be it.
            box.Text = only.Text;
            Mark();
            Tell(only.Text == current ? "Found the mixer, at the address in use now." : "Found the mixer. Its address is filled in.", Look.Green);
        }
        else Tell("Found " + picks.Count + ". Click the one to use.", Look.Green);
    }

    void Release()
    {
        Process p = scanner;
        scanner = null;
        progress = -1;
        if (!scanBtn.IsDisposed) scanBtn.Text = "Scan";
        if (p == null) return;
        try { if (!p.HasExited) p.Kill(); } catch { }
        try { p.Dispose(); } catch { }
    }

    void Halt(string say)
    {
        if (scanner == null) return;
        Release();
        if (say != null && !IsDisposed) Tell(picks.Count > 0 ? say + " Click a mixer to use it." : say, Look.Dim);
    }

    public static string Run(Form owner, string current, string root, string node, bool restarts)
    {
        using (AddressDialog d = new AddressDialog(current, root, node, restarts))
        {
            DialogResult result;
            if (owner != null && owner.Visible && owner.WindowState != FormWindowState.Minimized)
            {
                d.StartPosition = FormStartPosition.CenterParent;
                result = d.ShowDialog(owner);
            }
            else
            {
                d.StartPosition = FormStartPosition.CenterScreen;
                d.TopMost = true;
                result = d.ShowDialog();
            }
            return result == DialogResult.OK ? d.Value : null;
        }
    }
}

// Ties the bridge to this program: if the window dies, the bridge goes too.
static class Leash
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct Basic
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Counters { public ulong A, B, C, D, E, F; }

    [StructLayout(LayoutKind.Sequential)]
    struct Extended
    {
        public Basic Limits;
        public Counters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    static IntPtr job = IntPtr.Zero;

    public static void Hold(Process child)
    {
        try
        {
            if (job == IntPtr.Zero)
            {
                job = CreateJobObject(IntPtr.Zero, null);
                Extended info = new Extended();
                info.Limits.LimitFlags = 0x2000; // kill on close
                int size = Marshal.SizeOf(typeof(Extended));
                IntPtr mem = Marshal.AllocHGlobal(size);
                Marshal.StructureToPtr(info, mem, false);
                SetInformationJobObject(job, 9, mem, (uint)size);
                Marshal.FreeHGlobal(mem);
            }
            AssignProcessToJobObject(job, child.Handle);
        }
        catch { }
    }
}

// --- QR codes: plain bytes, error correction level M, sizes 1 to 6 (106 letters) ---
static class Qr
{
    // Per size: codewords in all, correction codewords per block, blocks.
    static readonly int[] Total = { 0, 26, 44, 70, 100, 134, 172 };
    static readonly int[] Correction = { 0, 10, 16, 26, 18, 24, 16 };
    static readonly int[] Blocks = { 0, 1, 1, 1, 2, 2, 4 };

    // The code as rows of dark and light, or null when the text does not fit.
    public static bool[,] Make(string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text ?? "");
        if (bytes.Length == 0) return null;
        int version = 0;
        for (int v = 1; v <= 6 && version == 0; v++)
            if (bytes.Length + 2 <= Total[v] - Correction[v] * Blocks[v]) version = v;
        if (version == 0) return null;

        // "Bytes follow", how many, the bytes, an end mark, then filler.
        int room = Total[version] - Correction[version] * Blocks[version];
        byte[] data = new byte[room];
        data[0] = (byte)(0x40 | (bytes.Length >> 4));
        data[1] = (byte)((bytes.Length & 15) << 4);
        for (int i = 0; i < bytes.Length; i++)
        {
            data[i + 1] |= (byte)(bytes[i] >> 4);
            data[i + 2] = (byte)((bytes[i] & 15) << 4);
        }
        for (int i = bytes.Length + 2, k = 0; i < room; i++, k++) data[i] = (byte)(k % 2 == 0 ? 0xEC : 0x11);

        // Correction codewords for each block, then everything dealt out in turns.
        int blocks = Blocks[version], each = room / blocks, extra = Correction[version];
        byte[] divisor = Divisor(extra);
        byte[][] spare = new byte[blocks][];
        for (int b = 0; b < blocks; b++) spare[b] = Remainder(data, b * each, each, divisor);
        byte[] all = new byte[Total[version]];
        int at = 0;
        for (int i = 0; i < each; i++) for (int b = 0; b < blocks; b++) all[at++] = data[b * each + i];
        for (int i = 0; i < extra; i++) for (int b = 0; b < blocks; b++) all[at++] = spare[b][i];

        int size = version * 4 + 17;
        bool[,] dark = new bool[size, size];
        bool[,] fixedPart = new bool[size, size];
        for (int i = 0; i < size; i++)
        {
            Fix(dark, fixedPart, 6, i, i % 2 == 0);
            Fix(dark, fixedPart, i, 6, i % 2 == 0);
        }
        Finder(dark, fixedPart, 3, 3);
        Finder(dark, fixedPart, size - 4, 3);
        Finder(dark, fixedPart, 3, size - 4);
        if (version > 1)
        {
            int c = size - 7;
            for (int dy = -2; dy <= 2; dy++)
                for (int dx = -2; dx <= 2; dx++)
                    Fix(dark, fixedPart, c + dx, c + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
        }
        Format(dark, fixedPart, 0);

        // The codewords, in a zigzag from the bottom right.
        int bit = 0;
        for (int right = size - 1; right >= 1; right -= 2)
        {
            if (right == 6) right = 5;
            for (int step = 0; step < size; step++)
            {
                for (int j = 0; j < 2; j++)
                {
                    int x = right - j;
                    bool upward = ((right + 1) & 2) == 0;
                    int y = upward ? size - 1 - step : step;
                    if (fixedPart[y, x] || bit >= all.Length * 8) continue;
                    dark[y, x] = ((all[bit >> 3] >> (7 - (bit & 7))) & 1) != 0;
                    bit++;
                }
            }
        }

        // Of the eight patterns laid over it, the one that reads best.
        int best = 0, least = int.MaxValue;
        for (int mask = 0; mask < 8; mask++)
        {
            Mask(dark, fixedPart, mask);
            Format(dark, fixedPart, mask);
            int penalty = Penalty(dark);
            if (penalty < least) { least = penalty; best = mask; }
            Mask(dark, fixedPart, mask);
        }
        Mask(dark, fixedPart, best);
        Format(dark, fixedPart, best);
        return dark;
    }

    static void Fix(bool[,] dark, bool[,] fixedPart, int x, int y, bool on)
    {
        dark[y, x] = on;
        fixedPart[y, x] = true;
    }

    static void Finder(bool[,] dark, bool[,] fixedPart, int x, int y)
    {
        int size = dark.GetLength(0);
        for (int dy = -4; dy <= 4; dy++)
        {
            for (int dx = -4; dx <= 4; dx++)
            {
                int xx = x + dx, yy = y + dy, far = Math.Max(Math.Abs(dx), Math.Abs(dy));
                if (xx >= 0 && xx < size && yy >= 0 && yy < size) Fix(dark, fixedPart, xx, yy, far != 2 && far != 4);
            }
        }
    }

    // Which pattern was used, written twice next to the corners.
    static void Format(bool[,] dark, bool[,] fixedPart, int mask)
    {
        int size = dark.GetLength(0);
        int data = mask; // level M is 00
        int rem = data;
        for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        int bits = ((data << 10) | rem) ^ 0x5412;
        for (int i = 0; i <= 5; i++) Fix(dark, fixedPart, 8, i, ((bits >> i) & 1) != 0);
        Fix(dark, fixedPart, 8, 7, ((bits >> 6) & 1) != 0);
        Fix(dark, fixedPart, 8, 8, ((bits >> 7) & 1) != 0);
        Fix(dark, fixedPart, 7, 8, ((bits >> 8) & 1) != 0);
        for (int i = 9; i < 15; i++) Fix(dark, fixedPart, 14 - i, 8, ((bits >> i) & 1) != 0);
        for (int i = 0; i < 8; i++) Fix(dark, fixedPart, size - 1 - i, 8, ((bits >> i) & 1) != 0);
        for (int i = 8; i < 15; i++) Fix(dark, fixedPart, 8, size - 15 + i, ((bits >> i) & 1) != 0);
        Fix(dark, fixedPart, 8, size - 8, true);
    }

    static void Mask(bool[,] dark, bool[,] fixedPart, int mask)
    {
        int size = dark.GetLength(0);
        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++)
            {
                if (fixedPart[y, x]) continue;
                bool flip;
                switch (mask)
                {
                    case 0: flip = (x + y) % 2 == 0; break;
                    case 1: flip = y % 2 == 0; break;
                    case 2: flip = x % 3 == 0; break;
                    case 3: flip = (x + y) % 3 == 0; break;
                    case 4: flip = (x / 3 + y / 2) % 2 == 0; break;
                    case 5: flip = x * y % 2 + x * y % 3 == 0; break;
                    case 6: flip = (x * y % 2 + x * y % 3) % 2 == 0; break;
                    default: flip = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
                }
                if (flip) dark[y, x] = !dark[y, x];
            }
        }
    }

    static readonly bool[] Lure = { true, false, true, true, true, false, true, false, false, false, false };

    // How hard the code would be to read: long runs, blocks, shapes that
    // look like the corner marks, and too much of one colour all count.
    static int Penalty(bool[,] dark)
    {
        int size = dark.GetLength(0), result = 0, count = 0;
        for (int turn = 0; turn < 2; turn++)
        {
            for (int a = 0; a < size; a++)
            {
                int run = 0;
                bool last = false;
                for (int b = 0; b < size; b++)
                {
                    bool now = turn == 0 ? dark[a, b] : dark[b, a];
                    if (b > 0 && now == last) run++;
                    else { if (run >= 5) result += run - 2; run = 1; }
                    last = now;
                    if (b + 11 <= size)
                    {
                        bool forward = true, backward = true;
                        for (int k = 0; k < 11; k++)
                        {
                            bool v = turn == 0 ? dark[a, b + k] : dark[b + k, a];
                            if (v != Lure[k]) forward = false;
                            if (v != Lure[10 - k]) backward = false;
                        }
                        if (forward) result += 40;
                        if (backward) result += 40;
                    }
                }
                if (run >= 5) result += run - 2;
            }
        }
        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++)
            {
                if (dark[y, x]) count++;
                if (x + 1 < size && y + 1 < size && dark[y, x] == dark[y, x + 1] && dark[y, x] == dark[y + 1, x] && dark[y, x] == dark[y + 1, x + 1]) result += 3;
            }
        }
        int total = size * size;
        result += ((Math.Abs(count * 20 - total * 10) + total - 1) / total - 1) * 10;
        return result;
    }

    // Reed-Solomon arithmetic, as the standard asks for.
    static int Times(int x, int y)
    {
        int z = 0;
        for (int i = 7; i >= 0; i--)
        {
            z = (z << 1) ^ ((z >> 7) * 0x11D);
            z ^= ((y >> i) & 1) * x;
        }
        return z & 0xFF;
    }

    static byte[] Divisor(int degree)
    {
        byte[] r = new byte[degree];
        r[degree - 1] = 1;
        int root = 1;
        for (int i = 0; i < degree; i++)
        {
            for (int j = 0; j < degree; j++)
            {
                r[j] = (byte)Times(r[j], root);
                if (j + 1 < degree) r[j] ^= r[j + 1];
            }
            root = Times(root, 2);
        }
        return r;
    }

    static byte[] Remainder(byte[] data, int start, int length, byte[] divisor)
    {
        byte[] r = new byte[divisor.Length];
        for (int k = 0; k < length; k++)
        {
            int factor = data[start + k] ^ r[0];
            Array.Copy(r, 1, r, 0, r.Length - 1);
            r[r.Length - 1] = 0;
            for (int i = 0; i < r.Length; i++) r[i] ^= (byte)Times(divisor[i], factor);
        }
        return r;
    }

    // The code on a tile of paper, in whole pixels so that it stays sharp.
    public static void Paint(Graphics g, bool[,] code, Rectangle tile, Color paper, Color ink, float radius)
    {
        using (GraphicsPath p = Look.Round(new RectangleF(tile.X, tile.Y, tile.Width, tile.Height), radius))
        using (SolidBrush b = new SolidBrush(paper))
            g.FillPath(b, p);
        if (code == null) return;
        int n = code.GetLength(0);
        int dot = Math.Max(1, tile.Width / (n + 4));
        int left = tile.X + (tile.Width - dot * n) / 2, top = tile.Y + (tile.Height - dot * n) / 2;
        GraphicsState before = g.Save();
        g.SmoothingMode = SmoothingMode.None;
        g.PixelOffsetMode = PixelOffsetMode.None;
        using (SolidBrush b = new SolidBrush(ink))
        {
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                    if (code[y, x]) g.FillRectangle(b, left + x * dot, top + y * dot, dot, dot);
        }
        g.Restore(before);
    }

    public static void WritePicture(string text, string file)
    {
        bool[,] code = Make(text);
        int n = code == null ? 21 : code.GetLength(0);
        using (Bitmap bmp = new Bitmap((n + 8) * 8, (n + 8) * 8))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            if (code != null) Paint(g, code, new Rectangle(0, 0, bmp.Width, bmp.Height), Color.White, Color.Black, 0);
            bmp.Save(file, ImageFormat.Png);
        }
    }
}

// The code large, for a phone across the room.
sealed class Poster : Form
{
    readonly bool[,] code;
    readonly string address;
    readonly Rectangle tile;

    public Poster(bool[,] code, string address)
    {
        this.code = code;
        this.address = address;
        Text = "Mixer Bridge";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ShowIcon = false;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Look.Panel;
        DoubleBuffered = true;
        KeyPreview = true;

        int pad = Look.S(26), side = Look.S(320);
        tile = new Rectangle(pad, Look.S(62), side, side);
        Btn close = new Btn("Close", BtnKind.Plain, Look.Panel);
        close.SetBounds(pad + side - Look.S(128), tile.Bottom + Look.S(72), Look.S(128), Look.S(38));
        close.Click += delegate { DialogResult = DialogResult.OK; };
        Controls.Add(close);
        ClientSize = new Size(side + pad * 2, close.Bottom + pad);
    }

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Look.DarkFrame(Handle); }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape) { e.Handled = true; DialogResult = DialogResult.Cancel; }
        base.OnKeyDown(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Panel);
        Look.Tracked(g, "SCAN TO OPEN THE MIXER", Look.Label(21), Look.Ink, tile.X, Look.S(22), Look.Scale * 0.8f);
        Qr.Paint(g, code, tile, Color.White, Look.Bg, Look.S(12));
        Font mono = Look.Mono(17);
        Look.Write(g, address, mono, Look.Amber, tile.X + (tile.Width - Look.Width(g, address, mono)) / 2f, tile.Bottom + Look.S(14), tile.Width);
        Font body = Look.Body(13);
        string hint = "The phone must be on the same Wi-Fi as this computer.";
        Look.Write(g, hint, body, Look.Dim, tile.X + (tile.Width - Look.Width(g, hint, body)) / 2f, tile.Bottom + Look.S(42), tile.Width);
    }
}

enum Phase { Stopped, Starting, Searching, Reading, InSync, Elsewhere, Failed }

// --- the window -------------------------------------------------------------------
sealed class MainForm : Form
{
    const int W = 460, H = 667, M = 18;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "MixerBridge";

    readonly Btn openBtn, restartBtn, toggleBtn, changeBtn, localBtn, copyBtn, largeBtn, copyLogBtn;
    readonly Tick autoStart;
    readonly LogView log;
    readonly NotifyIcon tray;
    readonly ToolStripMenuItem trayToggle, trayRestart, trayOpen;
    readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer pulse = new System.Windows.Forms.Timer();
    readonly Dictionary<Phase, Icon> trayIcons = new Dictionary<Phase, Icon>();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();

    string root, mixerHost = "192.168.0.144", model = "", lanAddress, reason = "", lastError = "";
    int port = 8600, screens;
    Phase phase = Phase.Stopped;
    Process child;
    bool wanted, asking, quitting, startHidden, hinted;
    int quickExits;
    DateTime startedAt;
    double beat;
    string codeFor;
    bool[,] code;

    static int S(float v) { return Look.S(v); }
    static Rectangle R(float x, float y, float w, float h) { return new Rectangle(S(x), S(y), S(w), S(h)); }

    public MainForm(bool hidden)
    {
        startHidden = hidden;
        Text = "Mixer Bridge";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Look.Bg;
        DoubleBuffered = true;
        ClientSize = new Size(S(W), S(H));
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        changeBtn = Add(new Btn("Change", BtnKind.Quiet, Look.Panel), W - M - 14 - 84, 74 + 18, 84, 30);
        localBtn = Add(new Btn("Open", BtnKind.Quiet, Look.Panel), W - M - 14 - 84, 186 + 17, 84, 30);
        copyBtn = Add(new Btn("Copy", BtnKind.Quiet, Look.Panel), M + 140, 186 + 65 + 90, 84, 30);
        largeBtn = Add(new Btn("Enlarge", BtnKind.Quiet, Look.Panel), M + 140 + 92, 186 + 65 + 90, 96, 30);
        openBtn = Add(new Btn("Open the mixer", BtnKind.Primary, Look.Bg), M, 405, 204, 46);
        openBtn.TextSize = 17;
        restartBtn = Add(new Btn("Restart", BtnKind.Plain, Look.Bg), M + 214, 405, 100, 46);
        toggleBtn = Add(new Btn("Stop", BtnKind.Plain, Look.Bg), M + 324, 405, 100, 46);
        autoStart = new Tick("Start with Windows, in the tray");
        autoStart.SetBounds(S(M), S(465), S(280), S(28));
        Controls.Add(autoStart);
        copyLogBtn = Add(new Btn("Copy", BtnKind.Quiet, Look.Bg), W - M - 64, 503, 64, 24);
        copyLogBtn.TextSize = 12.5f;
        log = new LogView();
        log.SetBounds(S(M), S(533), S(W - 2 * M), S(H - 533 - M));
        Controls.Add(log);

        changeBtn.Click += delegate { ChangeAddress(); };
        localBtn.Click += delegate { OpenMixer(); };
        openBtn.Click += delegate { OpenMixer(); };
        copyBtn.Click += delegate { CopyText(copyBtn, PhoneUrl()); };
        largeBtn.Click += delegate { ShowPoster(); };
        copyLogBtn.Click += delegate { CopyText(copyLogBtn, log.All()); };
        restartBtn.Click += delegate { AskRestart(); };
        toggleBtn.Click += delegate { Toggle(); };
        autoStart.On = AutoStartOn();
        autoStart.Changed += delegate { SetAutoStart(autoStart.On); };

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Renderer = new ToolStripProfessionalRenderer(new MenuColors());
        menu.ShowImageMargin = false;
        menu.ForeColor = Look.Ink;
        menu.BackColor = Look.Panel2;
        trayOpen = Item(menu, "Open the mixer", delegate { OpenMixer(); });
        Item(menu, "Show this window", delegate { Reveal(); });
        menu.Items.Add(new ToolStripSeparator());
        trayRestart = Item(menu, "Restart the bridge", delegate { AskRestart(); });
        trayToggle = Item(menu, "Stop the bridge", delegate { Toggle(); });
        menu.Items.Add(new ToolStripSeparator());
        Item(menu, "Quit", delegate { AskQuit(); });

        tray = new NotifyIcon();
        tray.ContextMenuStrip = menu;
        tray.Text = "Mixer Bridge";
        tray.Icon = TrayIcon(Phase.Stopped);
        tray.Visible = true;
        tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Reveal(); };

        poll.Interval = 1000;
        poll.Tick += delegate { Poll(); };
        poll.Start();
        pulse.Interval = 60;
        pulse.Tick += delegate { beat += 0.22; Invalidate(R(M, 74, 60, 60)); };

        Thread listener = new Thread(Listen);
        listener.IsBackground = true;
        listener.Start();

        Say("Mixer Bridge window started.", Look.Faint);
        Apply();
        Launch();
    }

    Btn Add(Btn b, float x, float y, float w, float h)
    {
        b.SetBounds(S(x), S(y), S(w), S(h));
        Controls.Add(b);
        return b;
    }

    static ToolStripMenuItem Item(ContextMenuStrip menu, string text, EventHandler run)
    {
        ToolStripMenuItem item = new ToolStripMenuItem(text);
        item.ForeColor = Look.Ink;
        item.Click += run;
        menu.Items.Add(item);
        return item;
    }

    // Started with --tray: stay out of sight until asked for.
    protected override void SetVisibleCore(bool value)
    {
        if (startHidden)
        {
            startHidden = false;
            if (!IsHandleCreated) CreateHandle();
            value = false;
        }
        base.SetVisibleCore(value);
    }

    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Look.DarkFrame(Handle); }

    // --- signals from a second start and from the snapshot helper ------------------
    void Listen()
    {
        using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowSignal))
        using (EventWaitHandle shot = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShotSignal))
        {
            WaitHandle[] both = { show, shot };
            while (true)
            {
                int which = WaitHandle.WaitAny(both);
                try
                {
                    if (which == 0) BeginInvoke((MethodInvoker)Reveal);
                    else BeginInvoke((MethodInvoker)Snapshot);
                }
                catch { }
            }
        }
    }

    void Reveal()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    void Snapshot()
    {
        Reveal();
        System.Windows.Forms.Timer wait = new System.Windows.Forms.Timer();
        wait.Interval = 400;
        wait.Tick += delegate
        {
            wait.Stop();
            wait.Dispose();
            try
            {
                string file = File.ReadAllText(Program.ShotNote).Trim();
                Form front = Application.OpenForms[Application.OpenForms.Count - 1];
                using (Bitmap bmp = new Bitmap(front.Width, front.Height))
                {
                    front.DrawToBitmap(bmp, new Rectangle(0, 0, front.Width, front.Height));
                    bmp.Save(file, ImageFormat.Png);
                }
            }
            catch (Exception err) { Say("Snapshot failed: " + err.Message, Look.Red); }
        };
        wait.Start();
    }

    // --- what is shown ---------------------------------------------------------------
    void Say(string text, Color color) { log.Add(text, color); }

    bool Ours { get { return child != null; } }
    bool Serving { get { return phase == Phase.Searching || phase == Phase.Reading || phase == Phase.InSync || phase == Phase.Elsewhere; } }
    bool MixerLinked { get { return Ours && (phase == Phase.Reading || phase == Phase.InSync); } }

    Color LampColor(Phase p)
    {
        switch (p)
        {
            case Phase.InSync: return Look.Green;
            case Phase.Failed: return Look.Red;
            case Phase.Stopped: return Look.Faint;
            default: return Look.Amber;
        }
    }

    Icon TrayIcon(Phase p)
    {
        Phase key = p == Phase.InSync || p == Phase.Failed || p == Phase.Stopped ? p : Phase.Searching;
        Icon icon;
        if (!trayIcons.TryGetValue(key, out icon))
        {
            icon = Art.Tray(LampColor(key));
            trayIcons[key] = icon;
        }
        return icon;
    }

    string Headline()
    {
        switch (phase)
        {
            case Phase.Starting: return "STARTING";
            case Phase.Searching: return "LOOKING FOR THE MIXER";
            case Phase.Reading: return "READING SETTINGS";
            case Phase.InSync: return "IN SYNC";
            case Phase.Elsewhere: return "RUNNING ELSEWHERE";
            case Phase.Failed: return "COULD NOT START";
            default: return "STOPPED";
        }
    }

    string Detail()
    {
        switch (phase)
        {
            case Phase.Starting: return "One moment.";
            case Phase.Searching: return "No answer from " + mixerHost + " yet.";
            case Phase.Reading: return "Found the mixer at " + mixerHost + ".";
            case Phase.InSync: return (model.Length > 0 ? model : "Mixer") + " at " + mixerHost;
            case Phase.Elsewhere: return "Another bridge already uses port " + port + ".";
            case Phase.Failed: return reason;
            default: return "The bridge is not running.";
        }
    }

    string Second()
    {
        switch (phase)
        {
            case Phase.Searching: return "Is it switched on and on this network?";
            case Phase.Elsewhere: return "Take over to run it from this window.";
            case Phase.Failed: return lastError;
            case Phase.Stopped: return "Screens cannot reach the mixer.";
            case Phase.Starting: return "";
            default: return screens == 0 ? "No screens connected" : screens == 1 ? "1 screen connected" : screens + " screens connected";
        }
    }

    string PhoneUrl() { return lanAddress == null ? null : "http://" + lanAddress + ":" + port + "/"; }

    void Apply()
    {
        toggleBtn.Text = phase == Phase.Elsewhere ? "Take over" : (phase == Phase.Stopped || phase == Phase.Failed) ? "Start" : "Stop";
        trayToggle.Text = phase == Phase.Elsewhere ? "Take over" : (phase == Phase.Stopped || phase == Phase.Failed) ? "Start the bridge" : "Stop the bridge";
        restartBtn.Enabled = Ours;
        trayRestart.Enabled = Ours;
        openBtn.Enabled = Serving;
        localBtn.Enabled = Serving;
        trayOpen.Enabled = Serving;
        copyBtn.Enabled = lanAddress != null;
        largeBtn.Enabled = Serving && lanAddress != null;
        bool moving = phase == Phase.Starting || phase == Phase.Searching || phase == Phase.Reading;
        if (pulse.Enabled != moving) { if (moving) pulse.Start(); else pulse.Stop(); }
        tray.Icon = TrayIcon(phase);
        string tip = "Mixer Bridge: " + Headline().ToLowerInvariant();
        tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
        Invalidate();
    }

    void Go(Phase next)
    {
        if (phase == next) return;
        phase = next;
        Apply();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Look.Prepare(g);
        g.Clear(Look.Bg);

        // Header
        GraphicsState at = g.Save();
        g.TranslateTransform(S(M), S(16));
        Art.Draw(g, S(42), null);
        g.Restore(at);
        using (GraphicsPath p = Look.Round(new RectangleF(S(M) + 0.5f, S(16) + 0.5f, S(42) - 1, S(42) - 1), S(42) * 14f / 64f))
        using (Pen pen = new Pen(Look.Line, 1))
            g.DrawPath(pen, p);
        Look.Tracked(g, "MIXER BRIDGE", Look.Label(24), Look.Ink, S(M + 56), S(14), Look.Scale * 1.4f);
        Look.Write(g, "Between your screens and the mixer", Look.Body(13), Look.Dim, S(M + 56), S(42), S(300));
        string portText = "PORT " + port;
        Font small = Look.Label(12.5f);
        float pw = Look.TrackedWidth(g, portText, small, Look.Scale * 1.1f);
        Look.Tracked(g, portText, small, Look.Faint, S(W - M) - pw, S(22), Look.Scale * 1.1f);

        // How things stand
        Rectangle card = R(M, 74, W - 2 * M, 100);
        Color lamp = LampColor(phase);
        using (GraphicsPath p = Look.Round(new RectangleF(card.X + 0.5f, card.Y + 0.5f, card.Width - 1, card.Height - 1), S(10)))
        {
            using (SolidBrush b = new SolidBrush(Look.Panel)) g.FillPath(b, p);
            Region keep = g.Clip;
            g.SetClip(p);
            using (SolidBrush b = new SolidBrush(lamp)) g.FillRectangle(b, card.X, card.Y, card.Width, S(3));
            g.Clip = keep;
            using (Pen pen = new Pen(Look.Line, 1)) g.DrawPath(pen, p);
        }
        float glow = pulse.Enabled ? (float)(0.5 + 0.5 * Math.Sin(beat)) : 1f;
        float cx = card.X + S(28), cy = card.Y + S(34);
        using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(26 + 40 * glow), lamp))) g.FillEllipse(b, cx - S(11), cy - S(11), S(22), S(22));
        using (SolidBrush b = new SolidBrush(Look.Blend(Look.Panel, lamp, 0.35f + 0.65f * glow))) g.FillEllipse(b, cx - S(6), cy - S(6), S(12), S(12));
        float textWidth = card.Width - S(48) - S(110);
        Look.Tracked(g, Headline(), Look.Label(26), Look.Ink, card.X + S(48), card.Y + S(17), Look.Scale * 1.2f);
        Look.Write(g, Detail(), Look.Medium(14), Look.Hex("c9cdd3"), card.X + S(48), card.Y + S(52), textWidth + S(110) - S(14));
        Look.Write(g, Second(), Look.Body(13), phase == Phase.Failed ? Look.Red : Look.Dim, card.X + S(48), card.Y + S(72), textWidth + S(110) - S(14));

        // Where to find it
        Rectangle where = R(M, 186, W - 2 * M, 201);
        using (GraphicsPath p = Look.Round(new RectangleF(where.X + 0.5f, where.Y + 0.5f, where.Width - 1, where.Height - 1), S(10)))
        {
            using (SolidBrush b = new SolidBrush(Look.Panel)) g.FillPath(b, p);
            using (Pen pen = new Pen(Look.Line, 1)) g.DrawPath(pen, p);
        }
        using (Pen pen = new Pen(Look.Line, 1)) g.DrawLine(pen, where.X + S(16), where.Y + S(65), where.Right - S(16), where.Y + S(65));
        Font cap = Look.Label(12.5f);
        Font url = Look.Mono(15);
        float urlWidth = where.Width - S(32) - S(96);
        Look.Tracked(g, "ON THIS COMPUTER", cap, Look.Dim, where.X + S(16), where.Y + S(13), Look.Scale * 1.1f);
        Look.Write(g, "http://localhost:" + port + "/", url, Serving ? Look.Ink : Look.Faint, where.X + S(16), where.Y + S(32), urlWidth);
        // For phones: the address, and the same as a code to point the camera at.
        bool reachable = Serving && lanAddress != null;
        Rectangle tile = CodeTile();
        Qr.Paint(g, Code(), tile, reachable ? Color.White : Look.Raised, reachable ? Look.Bg : Look.Edge, S(8));
        float column = where.X + S(140), columnWidth = where.Right - S(16) - column;
        Look.Tracked(g, "ON PHONES AND TABLETS", cap, Look.Dim, column, where.Y + S(65 + 15), Look.Scale * 1.1f);
        Look.Write(g, PhoneUrl() ?? "No network found", url, reachable ? Look.Amber : Look.Faint, column, where.Y + S(65 + 34), columnWidth);
        Look.Write(g, reachable ? "Point the phone's camera at the code." : "Shown here once the bridge runs.", Look.Body(12.5f), Look.Dim, column, where.Y + S(65 + 60), columnWidth);

        Look.Tracked(g, "ACTIVITY", cap, Look.Dim, S(M), S(509), Look.Scale * 1.1f);
    }

    // --- the bridge itself -----------------------------------------------------------
    static string FindRoot()
    {
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        for (int i = 0; i < 3 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "server", "index.js"))) return dir;
            dir = Path.GetDirectoryName(dir);
        }
        return null;
    }

    static string FindNode()
    {
        List<string> places = new List<string>((Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'));
        places.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        places.Add(@"C:\Program Files\nodejs");
        foreach (string place in places)
        {
            try
            {
                string file = Path.Combine(place.Trim().Trim('"'), "node.exe");
                if (File.Exists(file)) return file;
            }
            catch { }
        }
        return null;
    }

    string ConfigFile { get { return Path.Combine(root, "config.json"); } }

    Dictionary<string, object> ReadConfig()
    {
        try { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ConfigFile)) ?? new Dictionary<string, object>(); }
        catch { return new Dictionary<string, object>(); }
    }

    void LoadConfig()
    {
        Dictionary<string, object> config = ReadConfig();
        object value;
        if (config.TryGetValue("mixerHost", out value) && value != null) mixerHost = value.ToString();
        if (config.TryGetValue("port", out value) && value != null)
        {
            int n;
            if (int.TryParse(value.ToString(), out n) && n > 0 && n < 65536) port = n;
        }
        lanAddress = LocalAddress();
    }

    // This computer's address, the one on the mixer's network first.
    string LocalAddress()
    {
        string prefix = mixerHost.Contains(".") ? mixerHost.Substring(0, mixerHost.LastIndexOf('.') + 1) : "?";
        string found = null;
        try
        {
            foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (UnicastIPAddressInformation a in nic.GetIPProperties().UnicastAddresses)
                {
                    if (a.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    string text = a.Address.ToString();
                    if (text.StartsWith("169.254.")) continue;
                    if (text.StartsWith(prefix)) return text;
                    if (found == null) found = text;
                }
            }
        }
        catch { }
        return found;
    }

    bool PortTaken()
    {
        try
        {
            using (TcpClient probe = new TcpClient())
            {
                IAsyncResult wait = probe.BeginConnect("127.0.0.1", port, null, null);
                if (!wait.AsyncWaitHandle.WaitOne(400)) return false;
                probe.EndConnect(wait);
                return true;
            }
        }
        catch { return false; }
    }

    void Fail(string why, string more)
    {
        reason = why;
        lastError = more ?? "";
        wanted = false;
        Say(why + (more != null ? " " + more : ""), Look.Red);
        phase = Phase.Failed;
        Apply();
    }

    void Launch()
    {
        if (child != null) return;
        root = FindRoot();
        if (root == null) { Fail("The bridge files are missing.", "Keep MixerBridge.exe next to the server folder."); return; }
        LoadConfig();
        string node = FindNode();
        if (node == null) { Fail("Node.js is not installed.", "Get it from nodejs.org, then press Start."); return; }
        if (PortTaken())
        {
            Say("Port " + port + " is taken: a bridge runs in another window.", Look.Amber);
            Go(Phase.Elsewhere);
            return;
        }
        wanted = true;
        lastError = "";
        if (!Directory.Exists(Path.Combine(root, "node_modules", "ws")))
        {
            Say("First start: fetching what the bridge needs...", Look.Dim);
            Go(Phase.Starting);
            Process setup = Spawn(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/c npm install --omit=dev");
            if (setup == null) return;
            setup.Exited += delegate
            {
                int code = setup.ExitCode;
                BeginInvoke((MethodInvoker)delegate
                {
                    if (code != 0) Fail("Setting up did not work.", "Run start.bat once to see why.");
                    else if (wanted) StartNode(node);
                });
            };
            return;
        }
        StartNode(node);
    }

    Process Spawn(string file, string arguments)
    {
        ProcessStartInfo info = new ProcessStartInfo(file, arguments);
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.RedirectStandardInput = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables["MIXER_GUI"] = "1";
        Process p = new Process();
        p.StartInfo = info;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Heard(e.Data, false); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Heard(e.Data, true); };
        try
        {
            p.Start();
        }
        catch (Exception err)
        {
            Fail("Could not start " + Path.GetFileName(file) + ".", err.Message);
            return null;
        }
        Leash.Hold(p);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        return p;
    }

    void StartNode(string node)
    {
        Go(Phase.Starting);
        Process p = Spawn(node, "server\\index.js");
        if (p == null) return;
        child = p;
        startedAt = DateTime.Now;
        p.Exited += delegate
        {
            try { BeginInvoke((MethodInvoker)delegate { Gone(p); }); } catch { }
        };
        Apply();
    }

    void Heard(string line, bool error)
    {
        if (string.IsNullOrEmpty(line) || line.Trim().Length == 0) return;
        try
        {
            BeginInvoke((MethodInvoker)delegate
            {
                string text = line.TrimEnd();
                if (text.StartsWith("  ") && text.Contains("http://")) return;
                Color color = Look.Hex("b4bac3");
                if (error) { color = Look.Red; lastError = text.Trim(); }
                else if (text.Contains("in sync")) color = Look.Green;
                else if (text.Contains("lost") || text.Contains("failed")) color = Look.Amber;
                else if (text.StartsWith("  ")) color = Look.Dim;
                Say(text.StartsWith("[mixer] ") ? text.Substring(8) : text.Trim(), color);
            });
        }
        catch { }
    }

    // The bridge ended. If nobody asked for that, start it again.
    void Gone(Process p)
    {
        if (p != child) return;
        int code = 0;
        try { code = p.ExitCode; } catch { }
        p.Dispose();
        child = null;
        screens = 0;
        if (!wanted)
        {
            Go(Phase.Stopped);
            return;
        }
        bool quick = (DateTime.Now - startedAt).TotalSeconds < 10;
        quickExits = quick ? quickExits + 1 : 0;
        if (quickExits >= 3)
        {
            quickExits = 0;
            Fail("The bridge keeps stopping.", lastError.Length > 0 ? lastError : "See the activity below.");
            return;
        }
        Say("The bridge stopped by itself (code " + code + "). Starting it again...", Look.Amber);
        Go(Phase.Starting);
        System.Windows.Forms.Timer again = new System.Windows.Forms.Timer();
        again.Interval = 1200;
        again.Tick += delegate
        {
            again.Stop();
            again.Dispose();
            if (wanted && child == null) Launch();
        };
        again.Start();
    }

    void Halt()
    {
        wanted = false;
        Process p = child;
        if (p == null) return;
        child = null;
        try
        {
            // A tidy end first, so that the levels are written down.
            p.StandardInput.WriteLine("stop");
            p.StandardInput.Flush();
        }
        catch { }
        try
        {
            if (!p.WaitForExit(2000)) p.Kill();
        }
        catch { }
        try { p.Dispose(); } catch { }
        screens = 0;
        Say("Bridge stopped.", Look.Dim);
    }

    const string Drift = "The mixer may move toward the positions of its physical faders";

    void Toggle()
    {
        if (asking) return;
        if (phase == Phase.Elsewhere) { TakeOver(); return; }
        if (phase == Phase.Stopped || phase == Phase.Failed) { quickExits = 0; Launch(); return; }
        if (MixerLinked && !Confirm("Stop the bridge?", "Every screen loses its connection. " + Drift + ", because they are what counts when nothing is connected.", "Stop", "Keep running", true)) return;
        Halt();
        Go(Phase.Stopped);
    }

    void AskRestart()
    {
        if (asking || !Ours) return;
        if (MixerLinked && !Confirm("Restart the bridge?", "Screens find their way back by themselves. " + Drift + " for a couple of seconds, until the levels are put back.", "Restart", "Cancel", false)) return;
        Halt();
        phase = Phase.Stopped;
        quickExits = 0;
        Launch();
        Apply();
    }

    void AskQuit()
    {
        if (asking) return;
        if (MixerLinked && !Confirm("Quit Mixer Bridge?", "Every screen loses its connection. " + Drift + ", because they are what counts when nothing is connected.", "Quit", "Keep running", true)) return;
        quitting = true;
        Close();
    }

    bool Confirm(string title, string message, string ok, string cancel, bool danger)
    {
        asking = true;
        try { return Dialog.Ask(this, title, message, ok, cancel, danger); }
        finally { asking = false; }
    }

    void ChangeAddress()
    {
        if (asking) return;
        if (root == null) root = FindRoot();
        if (root == null) return;
        asking = true;
        string typed;
        try { typed = AddressDialog.Run(this, mixerHost, root, FindNode(), Ours); }
        finally { asking = false; }
        if (typed == null || typed == mixerHost) return;
        if (!Regex.IsMatch(typed, @"^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$"))
        {
            Say("\"" + typed + "\" does not look like an address.", Look.Red);
            return;
        }
        try
        {
            Dictionary<string, object> config = ReadConfig();
            config["mixerHost"] = typed;
            if (!config.ContainsKey("port")) config["port"] = port;
            StringBuilder sb = new StringBuilder("{\r\n");
            int i = 0;
            foreach (KeyValuePair<string, object> pair in config)
                sb.Append("  ").Append(json.Serialize(pair.Key)).Append(": ").Append(json.Serialize(pair.Value)).Append(++i < config.Count ? ",\r\n" : "\r\n");
            sb.Append("}\r\n");
            File.WriteAllText(ConfigFile, sb.ToString());
        }
        catch (Exception err)
        {
            Say("Could not save the address: " + err.Message, Look.Red);
            return;
        }
        Say("Mixer address changed to " + typed + ".", Look.Ink);
        mixerHost = typed;
        model = "";
        if (Ours)
        {
            Halt();
            phase = Phase.Stopped;
            Launch();
        }
        else if (phase == Phase.Elsewhere) Say("The other bridge keeps its address until it is restarted.", Look.Amber);
        Apply();
    }

    // --- a bridge that was started from the black window ----------------------------
    int ListenerOf(int wantedPort)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("netstat.exe", "-ano -p TCP");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            using (Process p = Process.Start(info))
            {
                string text = p.StandardOutput.ReadToEnd();
                p.WaitForExit(3000);
                Match m = Regex.Match(text, @"^\s*TCP\s+\S+:" + wantedPort + @"\s+\S+\s+LISTENING\s+(\d+)", RegexOptions.Multiline);
                return m.Success ? int.Parse(m.Groups[1].Value) : 0;
            }
        }
        catch { return 0; }
    }

    static bool Describe(int pid, out string name, out int parent, out string command)
    {
        name = ""; parent = 0; command = "";
        try
        {
            using (ManagementObjectSearcher s = new ManagementObjectSearcher("SELECT Name, ParentProcessId, CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
            {
                foreach (ManagementObject o in s.Get())
                {
                    name = Convert.ToString(o["Name"]);
                    parent = Convert.ToInt32(o["ParentProcessId"]);
                    command = Convert.ToString(o["CommandLine"]);
                    return true;
                }
            }
        }
        catch { }
        return false;
    }

    void TakeOver()
    {
        if (!Confirm("Take over the bridge?", "The bridge running in the other window is stopped and started again here. " + Drift + " for a couple of seconds, until the levels are put back.", "Take over", "Cancel", false)) return;
        int pid = ListenerOf(port);
        if (pid > 0)
        {
            string name, command, parentName, parentCommand;
            int parent, grand;
            if (!Describe(pid, out name, out parent, out command) || !name.StartsWith("node", StringComparison.OrdinalIgnoreCase))
            {
                Fail("Port " + port + " is used by another program.", (name.Length > 0 ? name : "It") + " is not a mixer bridge. Close it, or set another port in config.json.");
                return;
            }
            bool window = Describe(parent, out parentName, out grand, out parentCommand)
                && parentName.Equals("cmd.exe", StringComparison.OrdinalIgnoreCase)
                && parentCommand.IndexOf("start.bat", StringComparison.OrdinalIgnoreCase) >= 0;
            try
            {
                // The window first: left alone it would ask to press a key.
                if (window) Process.GetProcessById(parent).Kill();
            }
            catch { }
            try { Process.GetProcessById(pid).Kill(); }
            catch (Exception err)
            {
                Fail("Could not stop the other bridge.", err.Message);
                return;
            }
            Say("Stopped the bridge in the other window.", Look.Dim);
            for (int i = 0; i < 20 && PortTaken(); i++) Thread.Sleep(150);
        }
        phase = Phase.Stopped;
        quickExits = 0;
        Launch();
        Apply();
    }

    // --- asking the bridge how things stand ------------------------------------------
    bool polling;

    void Poll()
    {
        if (polling || quitting) return;
        if (!Ours && phase != Phase.Elsewhere) return;
        polling = true;
        int askPort = port;
        ThreadPool.QueueUserWorkItem(delegate
        {
            string body = null;
            bool answered = false;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + askPort + "/status.json");
                req.Proxy = null;
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                req.KeepAlive = false;
                using (WebResponse res = req.GetResponse())
                using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    body = reader.ReadToEnd();
                answered = true;
            }
            catch (WebException err)
            {
                // An older bridge answers, but does not know the question.
                answered = err.Response != null;
                if (err.Response != null) err.Response.Close();
            }
            catch { }
            try { BeginInvoke((MethodInvoker)delegate { polling = false; Told(body, answered); }); }
            catch { polling = false; }
        });
    }

    void Told(string body, bool answered)
    {
        if (quitting) return;
        if (phase == Phase.Elsewhere)
        {
            // The other bridge was closed: this window takes its place.
            if (!answered && !PortTaken()) { phase = Phase.Stopped; Launch(); Apply(); }
            return;
        }
        if (!Ours || body == null) return;
        try
        {
            Dictionary<string, object> s = json.Deserialize<Dictionary<string, object>>(body);
            bool connected = s.ContainsKey("connected") && Convert.ToBoolean(s["connected"]);
            bool synced = s.ContainsKey("synced") && Convert.ToBoolean(s["synced"]);
            if (s.ContainsKey("host") && s["host"] != null) mixerHost = s["host"].ToString();
            Dictionary<string, object> info = s.ContainsKey("info") ? s["info"] as Dictionary<string, object> : null;
            if (info != null && info.ContainsKey("model") && info["model"] != null) model = info["model"].ToString();
            string address = null;
            IEnumerable list = s.ContainsKey("addresses") ? s["addresses"] as IEnumerable : null;
            if (list != null) foreach (object a in list) { address = Convert.ToString(a); break; }
            int now = s.ContainsKey("screens") ? Convert.ToInt32(s["screens"]) : 0;
            Phase next = connected ? (synced ? Phase.InSync : Phase.Reading) : Phase.Searching;
            bool changed = next != phase || now != screens || address != lanAddress;
            screens = now;
            lanAddress = address ?? lanAddress;
            if (next == Phase.InSync) quickExits = 0;
            phase = next;
            if (changed) Apply();
        }
        catch { }
    }

    // --- the code for phones ---------------------------------------------------------
    static Rectangle CodeTile() { return R(M + 16, 186 + 65 + 14, 108, 108); }

    bool[,] Code()
    {
        string address = PhoneUrl();
        if (address != codeFor)
        {
            codeFor = address;
            code = address == null ? null : Qr.Make(address);
        }
        return code;
    }

    void ShowPoster()
    {
        if (asking || !Serving || Code() == null) return;
        asking = true;
        try
        {
            using (Poster poster = new Poster(Code(), PhoneUrl()))
            {
                poster.StartPosition = FormStartPosition.CenterParent;
                poster.ShowDialog(this);
            }
        }
        finally { asking = false; }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        Cursor = Serving && lanAddress != null && CodeTile().Contains(e.Location) ? Cursors.Hand : Cursors.Default;
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left && CodeTile().Contains(e.Location)) ShowPoster();
        base.OnMouseUp(e);
    }

    // --- small things ------------------------------------------------------------------
    void OpenMixer()
    {
        try { Process.Start("http://localhost:" + port + "/"); }
        catch (Exception err) { Say("Could not open the browser: " + err.Message, Look.Red); }
    }

    void CopyText(Btn button, string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        try { Clipboard.SetText(text); } catch { return; }
        string before = button.Text;
        if (before == "Copied") return;
        button.Text = "Copied";
        System.Windows.Forms.Timer back = new System.Windows.Forms.Timer();
        back.Interval = 1400;
        back.Tick += delegate { back.Stop(); back.Dispose(); button.Text = before; };
        back.Start();
    }

    static bool AutoStartOn()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                string value = key == null ? null : key.GetValue(RunName) as string;
                return value != null && value.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    void SetAutoStart(bool on)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) key.SetValue(RunName, "\"" + Application.ExecutablePath + "\" --tray");
                else key.DeleteValue(RunName, false);
            }
            Say(on ? "Mixer Bridge will start with Windows." : "Mixer Bridge will not start with Windows.", Look.Dim);
        }
        catch (Exception err)
        {
            Say("Could not change that: " + err.Message, Look.Red);
            autoStart.On = AutoStartOn();
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing)
        {
            // Closing the window leaves the bridge running, in the tray.
            e.Cancel = true;
            Hide();
            if (!hinted)
            {
                hinted = true;
                tray.ShowBalloonTip(4000, "Mixer Bridge keeps running", "It sits here by the clock. Right-click it to quit.", ToolTipIcon.None);
            }
            return;
        }
        quitting = true;
        poll.Stop();
        pulse.Stop();
        Halt();
        tray.Visible = false;
        base.OnFormClosing(e);
    }
}
