// Compiled with packaging/launcher/Launcher.cs by launcher.test.js to check the launcher's own
// logic. Takes the folder to unpack into and prints "ok" when every check passes.
using System;
using System.IO;
using System.IO.Compression;
using System.Text;

internal static class LauncherCheck
{
    private static int failures;

    private static void Check(bool ok, string what)
    {
        if (ok) return;
        failures++;
        Console.WriteLine("FAIL " + what);
    }

    private static void Write(ZipArchive zip, string name, string body)
    {
        using (StreamWriter w = new StreamWriter(zip.CreateEntry(name).Open(), new UTF8Encoding(false))) w.Write(body);
    }

    private static ZipArchive Zip(params string[] names)
    {
        MemoryStream ms = new MemoryStream();
        using (ZipArchive zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            foreach (string name in names)
            {
                if (name.EndsWith("/")) zip.CreateEntry(name);
                else Write(zip, name, name);
            }
        }
        ms.Position = 0;
        return new ZipArchive(ms, ZipArchiveMode.Read);
    }

    private static int Main(string[] args)
    {
        string dest = Path.Combine(args[0], "unpacked");

        Check(Launcher.Quote("plain") == "plain", "plain argument");
        Check(Launcher.Quote("") == "\"\"", "empty argument");
        Check(Launcher.Quote("a b") == "\"a b\"", "argument with a space");
        Check(Launcher.Quote("C:\\Program Files\\x\\") == "\"C:\\Program Files\\x\\\\\"", "argument ending in a backslash");
        Check(Launcher.Quote("say \"hi\"") == "\"say \\\"hi\\\"\"", "argument with quotes");

        foreach (string ok in new[] { "node\\node.exe", "f\\", "f\\Fabric App\\x.js" }) Check(Launcher.SafeEntry(ok), "safe entry " + ok);
        foreach (string bad in new[] { "", "\\x", "..\\x", "f\\..\\..\\x", "C:\\x", "f\\.\\x", "f\\\\x", "f\\x.", "f\\x " })
        {
            Check(!Launcher.SafeEntry(bad), "unsafe entry " + bad);
        }

        string deep = string.Join("/", new[] { "f", new string('a', 80), new string('b', 80), new string('c', 80), "file.js" });
        using (ZipArchive zip = Zip("node/", "node/node.exe", "f/empty/", deep)) Launcher.Extract(zip, dest);
        string longFile = Launcher.Long(dest) + "\\" + deep.Replace('/', '\\');
        Check(longFile.Length > 300, "unpacked path is only " + longFile.Length + " characters");
        Check(File.ReadAllText(longFile) == deep, "file past 260 characters");
        Check(File.ReadAllText(Path.Combine(dest, "node", "node.exe")) == "node/node.exe", "short file");
        Check(Directory.Exists(Path.Combine(dest, "f", "empty")), "empty folder");

        string outside = Path.Combine(args[0], "evil.txt");
        try
        {
            using (ZipArchive zip = Zip("../evil.txt")) Launcher.Extract(zip, Path.Combine(args[0], "damaged"));
            Check(false, "entry outside the folder is refused");
        }
        catch (InvalidDataException) { }
        Check(!File.Exists(outside), "nothing written outside the folder");

        Directory.Delete(Launcher.Long(dest), true);
        Check(!Directory.Exists(dest), "unpacked folder removed");

        Console.WriteLine(failures == 0 ? "ok" : failures + " failed");
        return failures == 0 ? 0 : 1;
    }
}
