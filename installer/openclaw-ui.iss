; OpenClaw UI — Windows installer.
;
; Built by scripts/build-installer.mjs, which stages release/ and passes the
; version in. Compiling this file by hand works too, but then the defaults
; below apply and the version will not match package.json:
;
;   ISCC.exe /DAppVersion=1.2.3 installer\openclaw-ui.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef VersionQuad
  ; Four numeric parts. Windows compares these, not the string, so a prerelease
  ; suffix cannot appear here — see scripts/lib/version.mjs.
  #define VersionQuad "0.0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\release"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist\installer"
#endif

#define AppName       "OpenClaw UI"
#define AppPublisher  "OpenClaw"
#define AppUrl        "https://github.com/MuhammadDaudNasir/OpenClaw-UI"
#define ExeName       "openclaw-shell.exe"

[Setup]
; Never change this GUID. It is how Windows recognises an existing install, so
; a new one turns every upgrade into a second, parallel copy.
AppId={{8C3F1A64-7E42-4B6D-9A15-2F0C5E8D3B71}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#VersionQuad}
VersionInfoProductVersion={#VersionQuad}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#ExeName}
OutputDir={#OutputDir}
OutputBaseFilename=OpenClaw-UI-{#AppVersion}-x64-setup
SetupIconFile=..\resources\icon.ico

; Per-user by default, so the common case needs no UAC prompt; the dialog lets
; anyone who wants a machine-wide install elevate and pick it.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; WebView2 and the shell's Win32 usage both want a current Windows 10.
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; The launcher lives in the tray, so an upgrade will meet a running instance
; holding its own exe open. Restart Manager closes it rather than failing on a
; locked file and leaving a half-written install.
CloseApplications=yes
RestartApplications=no

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
DisableDirPage=no
LicenseFile=..\LICENSE
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "Start {#AppName} when I sign in"; GroupDescription: "Startup"; Flags: unchecked

[Files]
; The staged release tree, minus anything that is a build by-product rather
; than a shipped file. spike.log/shell.log are traces written next to the exe
; by a dev run; shipping one would overwrite a user's first log with ours.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "*.log,*.pdb,*.ilk,*.exp,*.lib"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#ExeName}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: startup

[Run]
Filename: "{app}\{#ExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; \
  Flags: nowait postinstall skipifsilent

[Code]
{
  WebView2 is not optional: the shell renders its entire UI in it. When the
  runtime is absent the window opens and stays blank, which reads as a broken
  install rather than a missing dependency — so setup checks, and offers to
  fetch Microsoft's Evergreen bootstrapper.

  Windows 11 ships it. Windows 10 and Server frequently do not.
}
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  DownloadPage: TDownloadWizardPage;

function WebView2Version(RootKey: Integer; const SubKey: string): string;
begin
  Result := '';
  if not RegQueryStringValue(RootKey, SubKey, 'pv', Result) then Result := '';
end;

function WebView2Installed(): Boolean;
var
  Version: string;
begin
  { Machine-wide installs land under WOW6432Node even on 64-bit; per-user ones
    live in HKCU. A 'pv' of 0.0.0.0 means the key survived an uninstall. }
  Version := WebView2Version(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId);
  if Version = '' then
    Version := WebView2Version(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId);
  if Version = '' then
    Version := WebView2Version(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId);

  Result := (Version <> '') and (Version <> '0.0.0.0');
end;

function OnDownloadProgress(const Url, FileName: string; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard();
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), @OnDownloadProgress);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if (CurPageID <> wpReady) or WebView2Installed() then Exit;

  DownloadPage.Clear();
  DownloadPage.Add(WebView2BootstrapperUrl, 'MicrosoftEdgeWebview2Setup.exe', '');
  DownloadPage.Show();
  try
    try
      DownloadPage.Download();
    except
      { A failed download must not block the install: the app is still worth
        having on disk, and the runtime can be installed separately. Say so
        plainly rather than aborting. }
      SuppressibleMsgBox(
        'The WebView2 runtime could not be downloaded.' + #13#10#13#10 +
        'Setup will continue, but OpenClaw UI will show a blank window until the runtime is installed from:' + #13#10 +
        'https://developer.microsoft.com/microsoft-edge/webview2/',
        mbError, MB_OK, IDOK);
      Exit;
    end;

    { /silent /install is the bootstrapper's unattended form. Its exit code is
      reported but not treated as fatal, for the same reason as above. }
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '',
                SW_SHOW, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      SuppressibleMsgBox(
        'The WebView2 runtime installer did not complete successfully (code ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
        'Setup will continue. If OpenClaw UI opens to a blank window, install the runtime manually.',
        mbInformation, MB_OK, IDOK);
  finally
    DownloadPage.Hide();
  end;
end;
