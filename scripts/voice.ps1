param([ValidateSet('start','stop','status','models')] [string]$Action)

$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot '..\deploy\compose.voice.yaml'
$baseUrl = 'http://127.0.0.1:8000'
$approvedModels = @('Systran/faster-whisper-small', 'speaches-ai/Kokoro-82M-v1.0-ONNX')

if (-not $Action) {
    throw 'Specify one action: start, stop, status, or models. Nothing starts automatically.'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI not found on PATH. Start Docker Desktop and add its resources\bin directory to PATH.'
}

switch ($Action) {
    'start' {
        & docker compose -f $composeFile up -d
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start Speaches. Check Docker Desktop and NVIDIA GPU support.' }
    }
    'stop' {
        & docker compose -f $composeFile down
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not stop Speaches.' }
    }
    'status' {
        & docker compose -f $composeFile ps
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not read service status.' }
    }
    'models' {
        # The running pinned service is the authority: never download an unlisted model.
        $registry = Invoke-RestMethod -Uri "$baseUrl/v1/registry" -Method Get
        $registryItems = if ($null -ne $registry.data) { $registry.data } else { $registry }
        foreach ($id in $approvedModels) {
            if (-not @($registryItems | Where-Object { $_.id -ceq $id }).Count) {
                throw "Approved model '$id' is absent from the running Speaches registry; no model downloads were started."
            }
        }

        $installed = Invoke-RestMethod -Uri "$baseUrl/v1/models" -Method Get
        $installedItems = if ($null -ne $installed.data) { $installed.data } else { $installed }
        foreach ($id in $approvedModels) {
            if (-not @($installedItems | Where-Object { $_.id -ceq $id }).Count) {
                Write-Host "Installing $id (first run downloads model files)..."
                Invoke-RestMethod -Uri "$baseUrl/v1/models/$id" -Method Post | Out-Null
            }
        }

        $installed = Invoke-RestMethod -Uri "$baseUrl/v1/models" -Method Get
        $installedItems = if ($null -ne $installed.data) { $installed.data } else { $installed }
        foreach ($id in $approvedModels) {
            if (-not @($installedItems | Where-Object { $_.id -ceq $id }).Count) {
                throw "Model '$id' was not found after installation."
            }
            Write-Host "Installed: $id"
        }
        Write-Host 'Use Kokoro voice ef_dora for Spanish speech requests.'
    }
}
