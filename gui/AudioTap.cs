// AudioTap: reads one recording device of Windows and writes its sound to
// standard output, for the spectrum (RTA) of the bridge.
//
//   AudioTap.exe --list            names of the recording devices, one a line
//   AudioTap.exe --device "name"   sound of that device: mono, 16-bit, little
//                                  endian; the first line on standard error
//                                  says the sample rate ("rate 48000")
//
// It stops by itself when the bridge closes its input or stops reading.
// Uses the old waveIn functions of Windows: nothing to install.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class AudioTap
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WaveInCaps
    {
        public ushort mid;
        public ushort pid;
        public uint driverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string name;
        public uint formats;
        public ushort channels;
        public ushort reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WaveFormat
    {
        public ushort tag;
        public ushort channels;
        public uint rate;
        public uint bytesPerSecond;
        public ushort blockAlign;
        public ushort bits;
        public ushort extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WaveHeader
    {
        public IntPtr data;
        public uint length;
        public uint recorded;
        public IntPtr user;
        public uint flags;
        public uint loops;
        public IntPtr next;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveInGetDevCaps(UIntPtr id, ref WaveInCaps caps, int size);
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, UIntPtr id, ref WaveFormat format, IntPtr callback, IntPtr instance, int flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, int size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);

    const uint WHDR_DONE = 1;
    const int BUFFERS = 8;
    // 20 ms a buffer: short enough for a lively display.
    const int BUFFER_MS = 20;

    static volatile bool stop;

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--list")
        {
            foreach (string name in DeviceNames()) Console.WriteLine(name);
            return 0;
        }
        if (args.Length == 2 && args[0] == "--device") return Record(args[1]);
        Console.Error.WriteLine("Use: AudioTap --list | --device \"name\"");
        return 2;
    }

    static string[] DeviceNames()
    {
        uint count = waveInGetNumDevs();
        string[] names = new string[count];
        for (uint i = 0; i < count; i++)
        {
            WaveInCaps caps = new WaveInCaps();
            waveInGetDevCaps(new UIntPtr(i), ref caps, Marshal.SizeOf(typeof(WaveInCaps)));
            names[i] = caps.name ?? "";
        }
        return names;
    }

    static int Record(string wanted)
    {
        string[] names = DeviceNames();
        int id = Array.IndexOf(names, wanted);
        if (id < 0)
        {
            Console.Error.WriteLine("missing " + wanted);
            return 3;
        }

        // Two channels averaged into one; the rate the mixer uses first.
        IntPtr handle = IntPtr.Zero;
        WaveFormat format = new WaveFormat();
        int result = -1;
        foreach (uint rate in new uint[] { 48000, 44100 })
        {
            foreach (ushort channels in new ushort[] { 2, 1 })
            {
                format.tag = 1;
                format.channels = channels;
                format.rate = rate;
                format.bits = 16;
                format.blockAlign = (ushort)(channels * 2);
                format.bytesPerSecond = rate * format.blockAlign;
                format.extra = 0;
                result = waveInOpen(out handle, new UIntPtr((uint)id), ref format, IntPtr.Zero, IntPtr.Zero, 0);
                if (result == 0) break;
            }
            if (result == 0) break;
        }
        if (result != 0)
        {
            Console.Error.WriteLine("cannot open " + wanted + " (" + result + ")");
            return 4;
        }
        Console.Error.WriteLine("rate " + format.rate);
        Console.Error.Flush();

        // The bridge closing our input means: stop.
        Thread watch = new Thread(() =>
        {
            try { Console.OpenStandardInput().Read(new byte[1], 0, 1); } catch { }
            stop = true;
        });
        watch.IsBackground = true;
        watch.Start();

        int frames = (int)(format.rate * BUFFER_MS / 1000);
        int bytes = frames * format.blockAlign;
        int headerSize = Marshal.SizeOf(typeof(WaveHeader));
        IntPtr[] headers = new IntPtr[BUFFERS];
        for (int i = 0; i < BUFFERS; i++)
        {
            WaveHeader header = new WaveHeader();
            header.data = Marshal.AllocHGlobal(bytes);
            header.length = (uint)bytes;
            headers[i] = Marshal.AllocHGlobal(headerSize);
            Marshal.StructureToPtr(header, headers[i], false);
            waveInPrepareHeader(handle, headers[i], headerSize);
            waveInAddBuffer(handle, headers[i], headerSize);
        }
        waveInStart(handle);

        Stream output = Console.OpenStandardOutput();
        byte[] raw = new byte[bytes];
        byte[] mono = new byte[frames * 2];
        int next = 0;
        try
        {
            while (!stop)
            {
                WaveHeader header = (WaveHeader)Marshal.PtrToStructure(headers[next], typeof(WaveHeader));
                if ((header.flags & WHDR_DONE) == 0)
                {
                    Thread.Sleep(5);
                    continue;
                }
                int got = (int)header.recorded / format.blockAlign;
                Marshal.Copy(header.data, raw, 0, got * format.blockAlign);
                for (int f = 0; f < got; f++)
                {
                    int sample;
                    if (format.channels == 2)
                    {
                        int left = (short)(raw[f * 4] | (raw[f * 4 + 1] << 8));
                        int right = (short)(raw[f * 4 + 2] | (raw[f * 4 + 3] << 8));
                        sample = (left + right) / 2;
                    }
                    else
                    {
                        sample = (short)(raw[f * 2] | (raw[f * 2 + 1] << 8));
                    }
                    mono[f * 2] = (byte)(sample & 0xff);
                    mono[f * 2 + 1] = (byte)((sample >> 8) & 0xff);
                }
                output.Write(mono, 0, got * 2);
                output.Flush();

                waveInUnprepareHeader(handle, headers[next], headerSize);
                header.flags = 0;
                header.recorded = 0;
                Marshal.StructureToPtr(header, headers[next], false);
                waveInPrepareHeader(handle, headers[next], headerSize);
                waveInAddBuffer(handle, headers[next], headerSize);
                next = (next + 1) % BUFFERS;
            }
        }
        catch (IOException)
        {
            // The bridge is gone.
        }
        waveInReset(handle);
        for (int i = 0; i < BUFFERS; i++) waveInUnprepareHeader(handle, headers[i], headerSize);
        waveInClose(handle);
        return 0;
    }
}
