@echo off
setlocal EnableExtensions

rem ============================================================
rem leadfunnel.bat - iniciar, asesores y conciliacion
rem ============================================================
rem Doble clic abre un menu:
rem   1. Iniciar     despierta el servicio y carga Salesforce
rem   2. Asesores    leads por asesor y estado (pantalla + CSV)
rem   3. Conciliar   leads de Salesforce vs. leads en sesion
rem   4. Todo        1, 2 y 3 seguidos
rem
rem Tambien se puede ejecutar directo desde una consola:
rem   leadfunnel.bat iniciar
rem   leadfunnel.bat asesores
rem   leadfunnel.bat conciliar [AAAA-MM-DD]
rem   leadfunnel.bat todo
rem
rem Los resultados (.json y .csv) se guardan en esta carpeta.
rem ============================================================

rem ---- TOKEN -------------------------------------------------
rem Pegalo entre el = y las comillas finales, sin espacios:
rem   set "TOKEN=abc123..."
rem Si lo dejas vacio, se usa la variable MCP_TOKEN o se pide.
set "TOKEN="

set "API_URL=https://mcpfunnel.onrender.com"
set "ACCION=%~1"
set "DESDE=%~2"
set "CARPETA=%~dp0"

rem El codigo PowerShell esta al final de este mismo archivo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath '%~f0' -Raw; $i = $s.IndexOf('#' + 'PS' + '#'); Invoke-Expression $s.Substring($i)"

echo.
pause
exit /b

#PS#
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:base = $env:API_URL.TrimEnd('/')
$script:headers = $null

# ------------------------------------------------------------
# Utilidades
# ------------------------------------------------------------

function Titulo([string]$texto) {
  Write-Host ''
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host (' ' + $texto) -ForegroundColor Cyan
  Write-Host ('=' * 60) -ForegroundColor Cyan
}

function Archivo([string]$prefijo, [string]$ext) {
  Join-Path $env:CARPETA ($prefijo + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.' + $ext)
}

function Guardar([string]$ruta, [string]$texto) {
  # UTF-8 con BOM: Excel lo abre con los acentos bien.
  [System.IO.File]::WriteAllText($ruta, $texto, (New-Object System.Text.UTF8Encoding($true)))
}

function PedirToken {
  $token = $env:TOKEN
  if (-not $token) { $token = $env:MCP_TOKEN }
  if (-not $token) { $token = Read-Host 'Token (MCP_TOKEN)' }
  $token = ([string]$token).Trim().Trim('"').Trim()
  if (-not $token) { throw 'Falta el token.' }
  $script:headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
}

function Pedir([string]$metodo, [string]$ruta, [int]$timeout) {
  $code = 0
  $body = ''
  try {
    $p = @{ Uri = "$script:base$ruta"; Method = $metodo; Headers = $script:headers; TimeoutSec = $timeout; UseBasicParsing = $true }
    if ($metodo -eq 'POST') { $p.Body = '{}'; $p.ContentType = 'application/json' }
    $r = Invoke-WebRequest @p
    $code = [int]$r.StatusCode
    $body = [string]$r.Content
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { throw "No se pudo conectar con $script:base ($($_.Exception.Message))" }
    $code = [int]$resp.StatusCode
    $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
  }

  if ($body -match 'Just a moment') {
    throw 'Cloudflare bloqueo el pedido (pagina de desafio). Proba de nuevo en unos minutos o desde otra red.'
  }
  if ($code -eq 404 -and -not $body.Trim()) {
    throw 'Token incorrecto: el servidor respondio 404 sin contenido.'
  }
  try { $json = $body | ConvertFrom-Json } catch {
    $corto = $body.Substring(0, [Math]::Min(300, $body.Length))
    throw "Respuesta no JSON (HTTP $code): $corto"
  }
  return @{ code = $code; body = $body; json = $json }
}

function Estado {
  return (Pedir 'GET' '/estado' 180).json
}

function EsperarCarga($estado) {
  $esperado = 0
  while ($estado.cargaEnProceso) {
    if ($esperado -ge 1800) { throw 'La carga lleva mas de 30 minutos. Revisa los logs de Render.' }
    Write-Host "Carga de Salesforce en curso; esperando... ($([int]($esperado / 60)) min)"
    Start-Sleep -Seconds 15
    $esperado += 15
    $estado = (Pedir 'GET' '/estado' 60).json
  }
  return $estado
}

function Cargar {
  $todos = Read-Host 'Cargar solo los asesores del equipo (Enter) o TODOS los asesores (t)?'
  # /cargar lee todosLosAsesores del cuerpo JSON.
  $cuerpo = if ($todos -match '^[tT]') { '{"todosLosAsesores":true}' } else { '{}' }

  Write-Host 'Cargando desde Salesforce... (puede tardar varios minutos, no cierres la ventana)'
  try {
    $p = @{ Uri = "$script:base/cargar"; Method = 'POST'; Headers = $script:headers; TimeoutSec = 1800; UseBasicParsing = $true; Body = $cuerpo; ContentType = 'application/json' }
    $r = Invoke-WebRequest @p
    $j = $r.Content | ConvertFrom-Json
    if (-not $j.ok) { throw "Fallo /cargar: $($j.error)" }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 404) { throw 'Token incorrecto: el servidor respondio 404 sin contenido.' }
    if ($resp -and [int]$resp.StatusCode -eq 409) {
      Write-Host 'Ya habia una carga en curso.' -ForegroundColor Yellow
    } elseif ($resp) {
      $txt = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
      if ($txt -match 'Just a moment') { throw 'Cloudflare bloqueo el pedido. Proba de nuevo en unos minutos.' }
      # Si el servidor respondio con su propio error (JSON), la carga
      # fallo de verdad. Si no (pagina de timeout), sigue corriendo.
      $err = $null
      try { $err = ($txt | ConvertFrom-Json).error } catch { }
      if ($err) { throw "Fallo /cargar: $err" }
      Write-Host "La conexion se corto (HTTP $([int]$resp.StatusCode)); la carga sigue en el servidor." -ForegroundColor Yellow
    } else {
      Write-Host 'La conexion se corto; la carga sigue en el servidor.' -ForegroundColor Yellow
    }
  }

  $estado = EsperarCarga (Estado)
  if (-not $estado.sesionCargada) { throw 'La carga termino sin datos. Revisa los logs de Render.' }
  Write-Host "Carga terminada: $($estado.totalLeads) leads, $($estado.totalAdmitidos) admitidos." -ForegroundColor Green
  return $estado
}

# Garantiza que haya sesion cargada antes de consultar.
function AsegurarSesion {
  $estado = EsperarCarga (Estado)
  if ($estado.sesionCargada) { return $estado }
  Write-Host 'No hay datos cargados en el servidor.' -ForegroundColor Yellow
  $resp = Read-Host 'Cargar ahora desde Salesforce? (s/n)'
  if ($resp -notmatch '^[sS]') { throw 'Sin sesion cargada no se puede consultar.' }
  return Cargar
}

# ------------------------------------------------------------
# 1. Iniciar
# ------------------------------------------------------------

function Iniciar {
  Titulo 'INICIAR'
  Write-Host "Conectando con $script:base ..."
  Write-Host '(si el servicio estaba dormido puede tardar ~1 minuto)'

  $estado = EsperarCarga (Estado)
  Write-Host 'Servidor en linea.' -ForegroundColor Green

  if ($estado.sesionCargada) {
    Write-Host "Ya hay datos cargados: $($estado.totalLeads) leads, $($estado.totalAdmitidos) admitidos, ultima carga $($estado.ultimaCarga)."
    $resp = Read-Host 'Volver a cargar desde Salesforce? (s/N)'
    if ($resp -match '^[sS]') { Cargar | Out-Null }
  } else {
    Cargar | Out-Null
  }
}

# ------------------------------------------------------------
# 2. Asesores
# ------------------------------------------------------------

function Asesores {
  Titulo 'ASESORES'
  AsegurarSesion | Out-Null

  $termino = (Read-Host 'Filtrar por cohorte, ej. 2027S1 (Enter = todas)').Trim()
  $ruta = '/agregados?por=asesor&sub=estado'
  if ($termino) { $ruta += '&termino=' + [Uri]::EscapeDataString($termino) }

  $res = Pedir 'GET' $ruta 300
  $r = $res.json
  if (-not $r.ok) { throw "Error del servidor: $($r.error)" }

  $json = Archivo 'asesores' 'json'
  Guardar $json $res.body

  # Pantalla: asesor, total y los 3 estados mas frecuentes.
  $tabla = foreach ($f in $r.filas) {
    $estados = @()
    if ($f.desglose) {
      $estados = $f.desglose.PSObject.Properties |
        Select-Object -First 3 |
        ForEach-Object { "$($_.Name): $($_.Value)" }
    }
    [PSCustomObject]@{
      Asesor = $f.valor
      Leads = $f.total
      Porcentaje = if ($r.totalLeads) { '{0:N1} %' -f (100 * $f.total / $r.totalLeads) } else { '-' }
      'Estados principales' = ($estados -join ' | ')
    }
  }

  Write-Host ''
  if ($termino) { Write-Host "Cohorte: $termino" }
  Write-Host "Total de leads: $($r.totalLeads)"
  $tabla | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host

  # CSV para Excel: una fila por asesor y estado.
  $csv = Archivo 'asesores' 'csv'
  $lineas = @('Asesor;Estado;Leads')
  foreach ($f in $r.filas) {
    if ($f.desglose) {
      foreach ($e in $f.desglose.PSObject.Properties) {
        $lineas += ('"{0}";"{1}";{2}' -f ($f.valor -replace '"', '""'), ($e.Name -replace '"', '""'), $e.Value)
      }
    } else {
      $lineas += ('"{0}";"";{1}' -f ($f.valor -replace '"', '""'), $f.total)
    }
  }
  Guardar $csv ($lineas -join "`r`n")

  Write-Host "Detalle por estado (Excel): $csv"
  Write-Host "Respuesta completa: $json"
}

# ------------------------------------------------------------
# 3. Conciliar
# ------------------------------------------------------------

function Conciliar([string]$desde) {
  Titulo 'CONCILIACION'
  if (-not $desde) {
    $desde = (Read-Host 'Comparar desde (AAAA-MM-DD, Enter = 2026-01-01)').Trim()
  }
  if (-not $desde) { $desde = '2026-01-01' }
  if ($desde -notmatch '^\d{4}-\d{2}-\d{2}$') {
    throw "Fecha invalida: '$desde'. Formato AAAA-MM-DD, por ejemplo 2026-01-01."
  }

  AsegurarSesion | Out-Null

  Write-Host "Comparando contra Salesforce desde $desde ..."
  $res = Pedir 'GET' "/conciliacion?desde=$desde&incluirDetalle=true" 600
  $r = $res.json

  $json = Archivo 'conciliacion' 'json'
  Guardar $json $res.body

  if (-not $r.ok) { throw "Error del servidor: $($r.error)" }

  $color = switch ($r.estado) {
    'SIN_DIFERENCIAS' { 'Green' }
    'SESION_DESACTUALIZADA' { 'Yellow' }
    default { 'Red' }
  }

  Write-Host ''
  Write-Host ('Estado:                 ' + $r.estado) -ForegroundColor $color
  Write-Host ('Desde:                  ' + $r.alcance.desde)
  Write-Host ('Sesion cargada en:      ' + $r.cargadoEn)
  Write-Host ('Leads en Salesforce:    ' + $r.totalSalesforce)
  Write-Host ('Leads en sesion:        ' + $r.totalSesion)
  Write-Host ('Coinciden:              ' + $r.coinciden + ' (' + $r.porcentajeCobertura + ' %)')
  Write-Host ('Faltan en sesion:       ' + $r.faltantesEnSesion)
  Write-Host ('  creados despues:      ' + $r.creadosDespuesDeLaCarga)
  Write-Host ('  modificados despues:  ' + $r.modificadosDespuesDeLaCarga)
  Write-Host ('  ANOMALIAS:            ' + $r.anomalias)
  Write-Host ('Sobran en sesion:       ' + $r.sobrantesEnSesion)
  Write-Host ('Registrados acumulados: ' + $r.registradosAcumulados)

  if ($r.alcance.desdeAjustadoALaSesion) {
    Write-Host ''
    Write-Host 'Aviso: la fecha se ajusto al inicio de la sesion cargada.' -ForegroundColor Yellow
  }

  $anomalas = @($r.faltantes | Where-Object { $_.motivo -eq 'creado_antes_y_no_esta' })
  if ($anomalas.Count -gt 0) {
    Write-Host ''
    Write-Host 'Anomalias (primeras 20):' -ForegroundColor Red
    $anomalas | Select-Object -First 20 idSalesforce, nombre, creadoEn | Format-Table -AutoSize | Out-String | Write-Host
  } elseif ($r.estado -eq 'SESION_DESACTUALIZADA') {
    Write-Host ''
    Write-Host 'Las diferencias son esperables: se resuelven con una nueva carga (opcion 1).'
  }

  Write-Host ''
  Write-Host "Respuesta completa: $json"
}

# ------------------------------------------------------------
# Menu
# ------------------------------------------------------------

function Ejecutar([string]$accion) {
  try {
    switch ($accion) {
      'iniciar' { Iniciar }
      'asesores' { Asesores }
      'conciliar' { Conciliar $env:DESDE }
      'todo' { Iniciar; Asesores; Conciliar $env:DESDE }
      default { Write-Host "Opcion desconocida: $accion" -ForegroundColor Red }
    }
  } catch {
    Write-Host ''
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  }
}

try {
  PedirToken
} catch {
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  return
}

$accion = ([string]$env:ACCION).Trim().ToLower()
if ($accion) {
  Ejecutar $accion
  return
}

$opciones = @{ '1' = 'iniciar'; '2' = 'asesores'; '3' = 'conciliar'; '4' = 'todo' }

while ($true) {
  Titulo 'LEADFUNNEL'
  Write-Host ' 1. Iniciar    (despertar el servicio y cargar Salesforce)'
  Write-Host ' 2. Asesores   (leads por asesor y estado)'
  Write-Host ' 3. Conciliar  (Salesforce vs. sesion)'
  Write-Host ' 4. Todo       (1, 2 y 3 seguidos)'
  Write-Host ' 0. Salir'
  $op = (Read-Host 'Opcion').Trim()
  if ($op -eq '0' -or $op -eq '') { break }
  if (-not $opciones.ContainsKey($op)) { Write-Host 'Opcion no valida.' -ForegroundColor Yellow; continue }
  Ejecutar $opciones[$op]
}
