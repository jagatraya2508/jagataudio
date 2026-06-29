[Setup]
CloseApplications=force
AppName=JagatAudio
AppVersion=1.0
AppPublisher=JagatAudio
DefaultDirName={autopf}\JagatAudio
DefaultGroupName=JagatAudio
OutputDir=D:\Programer\jagataudio\build\installer_output
OutputBaseFilename=JagatAudio_Setup_v1.0
Compression=lzma2/ultra64
SolidCompression=yes
UninstallDisplayIcon={app}\JagatAudio.exe
ArchitecturesInstallIn64BitMode=x64

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "D:\Programer\jagataudio\build\pyinstaller_output\JagatAudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\JagatAudio"; Filename: "{app}\JagatAudio.exe"
Name: "{autodesktop}\JagatAudio"; Filename: "{app}\JagatAudio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\JagatAudio.exe"; Description: "{cm:LaunchProgram,JagatAudio}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{userappdata}\JagatAudio"

[Code]
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
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    KillJagatAudio();
  end;
end;
