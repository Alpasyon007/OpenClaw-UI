<#
.SYNOPSIS
  Build resources/icon.ico from resources/icon.png.

.DESCRIPTION
  The repo ships a single 1024x1024 PNG. Windows wants an .ico containing
  several sizes: it picks per context (16 for the title bar, 32 for the taskbar,
  256 for large Explorer views) and does NOT downscale well from one huge image
  — a 1024 source scaled to 16 is mush.

  Entries are stored as PNG rather than as a DIB. That is legal from Vista on,
  keeps the file a tenth of the size, and avoids the AND-mask that a 32-bit DIB
  entry needs and that is easy to get subtly wrong.

  Regenerate with:  pwsh -File scripts/make-ico.ps1
#>
param(
  [string] $Source = "$PSScriptRoot/../resources/icon.png",
  [string] $Target = "$PSScriptRoot/../resources/icon.ico"
)

Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
# Named apart from $Source: PowerShell variable names are case-insensitive,
# so reusing it would assign an Image into a [string]-typed parameter and
# silently store "System.Drawing.Bitmap" instead.
$image = [System.Drawing.Image]::FromFile((Resolve-Path $Source))

try {
  $payloads = foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      # HighQualityBicubic on a premultiplied surface; anything cheaper leaves
      # the 16px entry visibly ragged, which is the one users see most.
      $gfx.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $gfx.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $gfx.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $gfx.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $gfx.Clear([System.Drawing.Color]::Transparent)
      $gfx.DrawImage($image, 0, 0, $size, $size)
    } finally {
      $gfx.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    ,@{ Size = $size; Bytes = $stream.ToArray() }
  }

  $out = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter $out

  # ICONDIR: reserved, type 1 (icon), image count.
  $writer.Write([UInt16] 0)
  $writer.Write([UInt16] 1)
  $writer.Write([UInt16] $payloads.Count)

  # Entries come first, so every offset has to account for the whole directory.
  $offset = 6 + (16 * $payloads.Count)
  foreach ($p in $payloads) {
    # 0 means 256 in a single byte. 256 is the largest an .ico can describe.
    $dim = if ($p.Size -ge 256) { 0 } else { $p.Size }
    $writer.Write([Byte] $dim)          # width
    $writer.Write([Byte] $dim)          # height
    $writer.Write([Byte] 0)             # palette size, 0 for truecolour
    $writer.Write([Byte] 0)             # reserved
    $writer.Write([UInt16] 1)           # colour planes
    $writer.Write([UInt16] 32)          # bits per pixel
    $writer.Write([UInt32] $p.Bytes.Length)
    $writer.Write([UInt32] $offset)
    $offset += $p.Bytes.Length
  }

  foreach ($p in $payloads) { $writer.Write($p.Bytes) }

  $writer.Flush()
  [System.IO.File]::WriteAllBytes((Join-Path (Split-Path -Parent $Target) (Split-Path -Leaf $Target)), $out.ToArray())
  $writer.Dispose()

  Write-Output ("wrote {0} ({1} sizes, {2:N0} bytes)" -f $Target, $payloads.Count, (Get-Item $Target).Length)
} finally {
  $image.Dispose()
}
