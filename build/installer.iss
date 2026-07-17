#define MyAppName "JagatAudio"
#define MyAppVersion "1.2.0"
#define MyAppPublisher "JagatAudio"
#define MyAppId "{A7B3C9D1-4E2F-5A6B-8C9D-0E1F2A3B4C5D}"

[Setup]
AppId={{#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=D:\Programer\jagataudio\build\installer_output
OutputBaseFilename=JagatAudio_Setup_v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
UninstallDisplayIcon={app}\JagatAudio.exe
ArchitecturesInstallIn64BitMode=x64
CloseApplications=force
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; Upgrade: data user (lisensi, upload, proyek) ada di %APPDATA%\JagatAudio — tidak disentuh saat install ulang.

[InstallDelete]
; Bersihkan shortcut lama (upgrade v1.0 / install admin sebelumnya) agar tidak dobel
Type: files; Name: "{autodesktop}\{#MyAppName}.lnk"
Type: files; Name: "{commondesktop}\{#MyAppName}.lnk"
Type: files; Name: "{userdesktop}\{#MyAppName}.lnk"

[Files]
Source: "D:\Programer\jagataudio\build\pyinstaller_output\JagatAudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\JagatAudio.exe"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\JagatAudio.exe"

[Run]
Filename: "{app}\JagatAudio.exe"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
; Hanya hapus data user jika user uninstall — upgrade/install ulang tidak menjalankan section ini.

[Code]
procedure RemoveOldDesktopShortcuts();
begin
  DeleteFile(ExpandConstant('{autodesktop}\{#MyAppName}.lnk'));
  DeleteFile(ExpandConstant('{commondesktop}\{#MyAppName}.lnk'));
  DeleteFile(ExpandConstant('{userdesktop}\{#MyAppName}.lnk'));
end;

procedure KillJagatAudio();
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im JagatAudio.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    KillJagatAudio();
    RemoveOldDesktopShortcuts();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    KillJagatAudio();
    if MsgBox('Hapus juga data aplikasi (lisensi, proyek, upload) di AppData?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      Exec(ExpandConstant('{cmd}'), '/c rmdir /s /q "' + ExpandConstant('{userappdata}\JagatAudio') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;
