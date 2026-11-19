param([Parameter(Mandatory = $true)][string] $Origin)
$ErrorActionPreference = 'Stop'
if ($Origin -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}$') {
  throw 'A loopback fixture origin is required'
}
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class SuperbotFixtureCredential
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int BlobSize;
        public IntPtr Blob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite(ref Credential credential, int flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    public static void Create(string origin, string token)
    {
        string target = origin + "/.com.superbot.rakazo.session";
        const int generic = 1;
        IntPtr existing;
        if (CredRead(target, generic, 0, out existing))
        {
            CredFree(existing);
            throw new InvalidOperationException("Fixture origin already has a Windows credential");
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 1168) throw new Win32Exception(error);

        var blob = Marshal.StringToCoTaskMemUni(token);
        try
        {
            var credential = new Credential {
                Type = generic, TargetName = target, Blob = blob,
                BlobSize = Encoding.Unicode.GetByteCount(token),
                Persist = 1, UserName = "fixture"
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.ZeroFreeCoTaskMemUnicode(blob);
        }
    }
}
"@
$token = [Console]::In.ReadLine()
if (!$token) { throw 'A fixture session is required' }
[SuperbotFixtureCredential]::Create($Origin, $token)
