[Setup]
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
