# Send a test WhatsApp message via Cloud API.
# Usage (PowerShell, do not commit tokens):
#   $env:WHATSAPP_ACCESS_TOKEN = "your_system_user_token"
#   $env:WHATSAPP_TEST_TO = "549XXXXXXXXXX"
#   .\scripts\test-whatsapp-send.ps1

$ErrorActionPreference = "Stop"

$token = $env:WHATSAPP_ACCESS_TOKEN
$to = $env:WHATSAPP_TEST_TO
$phoneNumberId = if ($env:WHATSAPP_PHONE_NUMBER_ID) { $env:WHATSAPP_PHONE_NUMBER_ID } else { "1117612621444090" }
$graphVersion = "v22.0"

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "Set WHATSAPP_ACCESS_TOKEN (System User token from Meta Business)."
}
if ([string]::IsNullOrWhiteSpace($to)) {
    Write-Error "Set WHATSAPP_TEST_TO to your personal WhatsApp in digits only (e.g. 54911...)."
}

$body = @{
    messaging_product = "whatsapp"
    to                  = $to.Trim()
    type                = "text"
    text                = @{ body = "hola" }
} | ConvertTo-Json -Compress

$uri = "https://graph.facebook.com/$graphVersion/$phoneNumberId/messages"
Write-Host "POST $uri"
Write-Host "to=$to"

$response = Invoke-RestMethod -Method POST -Uri $uri `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" `
    -Body $body

$response | ConvertTo-Json -Depth 5
