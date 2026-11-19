[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'status', 'stop', 'bootstrap-reviewer')]
    [string]$Action = 'status',
    [string]$PostgresBin,
    [string]$ReviewerEmail,
    [Security.SecureString]$ReviewerPassword,
    [ValidateRange(1024, 65535)][int]$WebPort = 5173,
    [ValidateRange(1024, 65535)][int]$ApiPort = 3173,
    [ValidateRange(1024, 65535)][int]$DatabasePort = 55439
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$instance = Join-Path $env:LOCALAPPDATA 'Superbot\local'
$settingsFile = Join-Path $instance 'settings.json'
$processFile = Join-Path $instance 'processes.json'
$databaseDir = Join-Path $instance 'postgres'
$dataDir = Join-Path $instance 'data'
$tempDir = Join-Path $instance 'tmp'
$logsDir = Join-Path $instance 'logs'
$services = @('postgres', 'api', 'worker', 'web')
$records = @{}

function Write-JsonFile($Path, $Value) {
    $pending = "$Path.pending"
    [IO.File]::WriteAllText($pending, (ConvertTo-Json -InputObject $Value -Depth 4))
    if ([IO.File]::Exists($Path)) {
        [IO.File]::Replace($pending, $Path, "$Path.previous")
        [IO.File]::Delete("$Path.previous")
    } else {
        [IO.File]::Move($pending, $Path)
    }
}

function New-Secret {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Resolve-PostgresBin {
    if (-not $PostgresBin) {
        $command = Get-Command postgres.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($command) { $PostgresBin = Split-Path $command.Source }
    }
    if (-not $PostgresBin) { throw 'Install PostgreSQL or supply -PostgresBin with its bin directory.' }
    $bin = (Resolve-Path -LiteralPath $PostgresBin).Path
    foreach ($program in @('postgres.exe', 'initdb.exe', 'pg_ctl.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bin $program) -PathType Leaf)) { throw "Missing $program in $bin." }
    }
    $bin
}

function Get-ManagedProcess($Name) {
    if (-not $records.ContainsKey($Name)) { return }
    $record = $records[$Name]
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startedAt -and
        $process.Path -eq $record.executable) { $process }
}

function Confirm-FreePorts {
    foreach ($port in @($settings.webPort, $settings.apiPort, $settings.databasePort)) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        $listener.ExclusiveAddressUse = $true
        try { $listener.Start() }
        catch [Net.Sockets.SocketException] { throw "Port $port is unavailable. The service using it was left running." }
        finally { $listener.Stop() }
    }
}

function Start-LocalProcess($Name, $Executable, $Arguments, $Directory, [switch]$Wait) {
    $quoted = foreach ($argument in $Arguments) { '"' + $argument + '"' }
    $options = @{
        FilePath = $Executable
        ArgumentList = $quoted -join ' '
        WorkingDirectory = $Directory
        WindowStyle = 'Hidden'
        RedirectStandardOutput = Join-Path $logsDir "$Name.out.log"
        RedirectStandardError = Join-Path $logsDir "$Name.err.log"
        PassThru = $true
        Wait = $Wait
    }
    $process = Start-Process @options
    if ($Wait) {
        if ($process.ExitCode -ne 0) { throw "$Name failed. See $logsDir." }
    } else {
        $records[$Name] = @{
            id = $process.Id
            executable = $Executable
            startedAt = $process.StartTime.ToUniversalTime().Ticks.ToString()
        }
        Write-JsonFile $processFile $records
    }
}

function Test-LoopbackHttp($Url) {
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 2000
    try {
        $response = $request.GetResponse()
        try { [int]$response.StatusCode -eq 200 } finally { $response.Dispose() }
    } catch [Net.WebException] {
        if ($_.Exception.Response) { $_.Exception.Response.Dispose() }
        $false
    }
}

function Test-ServiceHealth($Name) {
    $process = Get-ManagedProcess $Name
    if (-not $process) { return $false }
    if ($Name -eq 'worker') {
        Push-Location (Join-Path $root 'apps/worker')
        try {
            & $node --import tsx src/health-check.ts
            return $LASTEXITCODE -eq 0
        } finally { Pop-Location }
    }
    $port = switch ($Name) {
        'postgres' { $settings.databasePort }
        'api' { $settings.apiPort }
        'web' { $settings.webPort }
    }
    $listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $port)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or
        $listeners[0].OwningProcess -ne $process.Id) { return $false }
    switch ($Name) {
        'postgres' {
            $pidFile = Join-Path $databaseDir 'postmaster.pid'
            if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
            return (Get-Content -LiteralPath $pidFile -Tail 1).Trim() -eq 'ready'
        }
        'api' { return Test-LoopbackHttp "$apiOrigin/ready" }
        'web' { return (Test-LoopbackHttp "$webOrigin/") -and (Test-LoopbackHttp "$webOrigin/api/auth/get-session") }
    }
}

function Wait-ServiceReady($Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        if (-not (Get-ManagedProcess $Name)) { throw "$Name exited during startup. See $logsDir." }
        if (Test-ServiceHealth $Name) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready. See $logsDir."
}

function Stop-Services {
    foreach ($name in @('web', 'worker', 'api', 'postgres')) {
        if (-not $records.ContainsKey($name)) { continue }
        $process = Get-ManagedProcess $name
        if ($process) {
            if ($name -eq 'postgres') {
                $pidFile = Join-Path $databaseDir 'postmaster.pid'
                if (-not (Test-Path -LiteralPath $pidFile) -or
                    (Get-Content -LiteralPath $pidFile -TotalCount 1) -ne $process.Id.ToString()) {
                    throw 'PostgreSQL process record and data directory disagree. Refusing to stop PostgreSQL.'
                }
                Start-LocalProcess 'postgres-stop' (Join-Path $settings.postgresBin 'pg_ctl.exe') @('stop', '-D', $databaseDir, '-m', 'fast', '-w') $instance -Wait
            } else {
                $process.Kill()
                if (-not $process.WaitForExit(10000)) { throw "Timed out stopping $name." }
            }
        }
        $records.Remove($name)
        Write-JsonFile $processFile $records
    }
}

function Initialize-Database {
    if (Test-Path -LiteralPath (Join-Path $databaseDir 'PG_VERSION')) { return }
    $passwordFile = Join-Path $instance 'postgres-init-password'
    [IO.File]::WriteAllText($passwordFile, $settings.databaseOwnerPassword)
    try {
        Start-LocalProcess 'postgres-init' (Join-Path $settings.postgresBin 'initdb.exe') @(
            '-D', $databaseDir, '-U', 'postgres', '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', '--pwfile', $passwordFile
        ) $instance -Wait
    } finally { Remove-Item -LiteralPath $passwordFile -Force }
}

function Initialize-Reviewer {
    if (-not $ReviewerEmail -or $ReviewerEmail.Trim().ToLowerInvariant() -notin $reviewerEmails) {
        throw 'Supply a -ReviewerEmail from reviewerEmails in the local settings file.'
    }
    if (-not (Test-ServiceHealth 'api')) { throw 'Start the local stack before bootstrapping a reviewer.' }
    if (-not $ReviewerPassword) {
        $ReviewerPassword = Read-Host 'Reviewer password (at least 16 characters)' -AsSecureString
    }
    if ($ReviewerPassword.Length -lt 16) { throw 'The reviewer password must have at least 16 characters.' }
    $password = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ReviewerPassword)
    try {
        $env:OWNER_EMAIL = $ReviewerEmail.Trim().ToLowerInvariant()
        $env:OWNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($password)
        Start-LocalProcess 'bootstrap-reviewer' $node @('--import', 'tsx', 'src/cli/bootstrap-owner.ts') (Join-Path $root 'apps/api') -Wait
        Write-Output 'The reviewer account is ready.'
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($password)
        [Environment]::SetEnvironmentVariable('OWNER_EMAIL', $null, 'Process')
        [Environment]::SetEnvironmentVariable('OWNER_PASSWORD', $null, 'Process')
    }
}

if ($Action -ne 'start' -and -not (Test-Path -LiteralPath $settingsFile)) {
    if ($Action -eq 'bootstrap-reviewer') { throw 'Start the local stack before bootstrapping a reviewer.' }
    Write-Output 'Superbot is stopped. Start it to create the local instance.'
    return
}

[void][IO.Directory]::CreateDirectory($instance)
$lock = [IO.File]::Open((Join-Path $instance 'host.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
Push-Location $root
$originalEnv = @{}
try {
    if (-not (Test-Path -LiteralPath $settingsFile)) {
        if (@(@($WebPort, $ApiPort, $DatabasePort) | Select-Object -Unique).Count -ne 3) {
            throw 'Web, API and database ports must be distinct.'
        }
        if (Test-Path -LiteralPath $databaseDir) { throw "Existing PostgreSQL data has no matching instance settings in $instance." }
        $settings = [PSCustomObject]@{
            repo = $root
            webPort = $WebPort
            apiPort = $ApiPort
            databasePort = $DatabasePort
            postgresBin = Resolve-PostgresBin
            databaseOwnerPassword = New-Secret
            databaseAppPassword = New-Secret
            authSecret = New-Secret
            encryptionKey = New-Secret
            screenProxySecret = New-Secret
            reviewerEmails = @()
        }
        Confirm-FreePorts
        Write-JsonFile $settingsFile $settings
    } else {
        $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        if ($settings.repo -ne $root) { throw "The existing instance belongs to another checkout at $($settings.repo)." }
        foreach ($parameter in @('WebPort', 'ApiPort', 'DatabasePort')) {
            if ($PSBoundParameters.ContainsKey($parameter) -and $PSBoundParameters[$parameter] -ne $settings.$parameter) {
                throw "The local instance already has $parameter $($settings.$parameter)."
            }
        }
        if ($PostgresBin -and (Resolve-PostgresBin) -ne $settings.postgresBin) {
            throw "The local instance already uses PostgreSQL at $($settings.postgresBin)."
        }
    }
    if (Test-Path -LiteralPath $processFile) {
        (Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object {
            $records[$_.Name] = $_.Value
        }
    }
    if ($Action -eq 'stop') {
        Stop-Services
        Write-Output 'Superbot stopped.'
        return
    }

    $node = (Get-Command node.exe -CommandType Application).Source
    $webOrigin = "http://127.0.0.1:$($settings.webPort)"
    $apiOrigin = "http://127.0.0.1:$($settings.apiPort)"
    $reviewerEmails = @()
    if ($settings.PSObject.Properties['reviewerEmails']) {
        $reviewerEmails = @(foreach ($email in $settings.reviewerEmails) {
            $address = [Net.Mail.MailAddress]::new($email.Trim())
            if ($address.Address -ne $email.Trim() -or $email -match '[,\s]') {
                throw 'reviewerEmails must contain individual email addresses.'
            }
            $address.Address.ToLowerInvariant()
        })
    }
    $localEnv = @{
        NODE_ENV = 'development'
        RAKAZO_ENV_FILE = 'none'
        RAKAZO_DB_PACKAGE_DIR = (Join-Path $root 'packages/db')
        TEMP = $tempDir
        TMP = $tempDir
        DATA_DIR = $dataDir
        API_HOST = '127.0.0.1'
        RAKAZO_DEV_HOST = '127.0.0.1'
        API_PORT = $settings.apiPort.ToString()
        WEB_PORT = $settings.webPort.ToString()
        API_URL = $apiOrigin
        API_PROXY_TARGET = $apiOrigin
        WEB_ORIGIN = $webOrigin
        BETTER_AUTH_URL = $webOrigin
        DATABASE_URL = "postgresql://superbot_app:$($settings.databaseAppPassword)@127.0.0.1:$($settings.databasePort)/postgres"
        BETTER_AUTH_SECRET = $settings.authSecret
        ENCRYPTION_KEY = $settings.encryptionKey
        SCREEN_PROXY_SECRET = $settings.screenProxySecret
        SANDBOX_PROVIDER = 'none'
        EMAIL_PROVIDER = 'none'
        AUTH_PASSWORD_ENABLED = 'true'
        SIGNUPS_ENABLED = 'true'
        RAKAZO_ADMIN_EMAILS = $reviewerEmails -join ','
        DATABASE_MIGRATION_URL = $null
    }
    $osEnv = @('APPDATA', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'OS', 'Path', 'PATHEXT',
        'PROCESSOR_ARCHITECTURE', 'ProgramData', 'ProgramFiles', 'SystemDrive', 'SystemRoot', 'USERNAME', 'USERPROFILE', 'windir')
    foreach ($entry in Get-ChildItem Env:) {
        if ($entry.Name -in $osEnv) { continue }
        $originalEnv[$entry.Name] = $entry.Value
        [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
    }
    foreach ($key in $localEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $localEnv[$key], 'Process') }

    if ($Action -eq 'bootstrap-reviewer') {
        Initialize-Reviewer
        return
    }

    $healthy = $true
    foreach ($name in $services) {
        $ready = Test-ServiceHealth $name
        if (-not $ready) { $healthy = $false }
        if ($Action -eq 'status') {
            $state = if ($ready) { 'ready' } elseif (Get-ManagedProcess $name) { 'unhealthy' } else { 'stopped' }
            Write-Output "$name $state"
        }
    }
    if ($Action -eq 'status' -or $healthy) {
        Write-Output $webOrigin
        return
    }
    if (@($services | Where-Object { Get-ManagedProcess $_ }).Count -gt 0) {
        throw 'The instance is partially running. Run stop before restarting it.'
    }
    Confirm-FreePorts
    foreach ($directory in @($root, (Join-Path $root 'apps/web'), (Join-Path $root 'packages/db'))) {
        foreach ($file in @('.env', '.env.local', '.env.development', '.env.development.local')) {
            if (Test-Path -LiteralPath (Join-Path $directory $file)) {
                throw "Found $file in $directory. Use a clean checkout for this isolated instance."
            }
        }
    }
    foreach ($directory in @($dataDir, $tempDir, $logsDir)) { [void][IO.Directory]::CreateDirectory($directory) }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'packages/db/src/generated/prisma/client.ts'))) {
        & pnpm.cmd db:generate
        if ($LASTEXITCODE -ne 0) { throw 'Prisma client generation failed.' }
    }
    Initialize-Database
    try {
        Start-LocalProcess 'postgres' (Join-Path $settings.postgresBin 'postgres.exe') @(
            '-D', $databaseDir, '-h', '127.0.0.1', '-p', $settings.databasePort.ToString()
        ) $instance
        Wait-ServiceReady 'postgres'
        $apiDir = Join-Path $root 'apps/api'
        $env:DATABASE_MIGRATION_URL = "postgresql://postgres:$($settings.databaseOwnerPassword)@127.0.0.1:$($settings.databasePort)/postgres"
        Start-LocalProcess 'migrate' $node @('--import', 'tsx', 'src/cli/migrate-database.ts') $apiDir -Wait
        [Environment]::SetEnvironmentVariable('DATABASE_MIGRATION_URL', $null, 'Process')
        Start-LocalProcess 'api' $node @('--import', 'tsx', 'src/index.ts') $apiDir
        Wait-ServiceReady 'api'
        [IO.File]::Delete((Join-Path $tempDir 'rakazo-worker-health.json'))
        Start-LocalProcess 'worker' $node @('--import', 'tsx', 'src/index.ts') (Join-Path $root 'apps/worker')
        Wait-ServiceReady 'worker'
        Start-LocalProcess 'web' $node @('node_modules/vite/bin/vite.js', '--strictPort') (Join-Path $root 'apps/web')
        Wait-ServiceReady 'web'
        Write-Output "Superbot is ready at $webOrigin"
    } catch {
        Stop-Services
        throw
    }
} finally {
    if (Test-Path Variable:localEnv) {
        foreach ($key in $localEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
    }
    foreach ($key in $originalEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $originalEnv[$key], 'Process') }
    Pop-Location
    $lock.Dispose()
}
