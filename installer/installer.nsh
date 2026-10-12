; Default install folder: D:\Recontech Agentic Tool when this computer has a D: drive, so the app (and,
; through it, its data) stays off the Windows drive. Runs before the installer reads where an earlier
; version went: a first install, or one that went to C: before, is pointed at D:. Anyone can still
; choose another folder on the next page.
!macro preInit
  IfFileExists "D:\*.*" 0 preInitDone
    SetRegView 64
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCpy $1 $0 2
    StrCmp $0 "" pointAtD
    StrCmp $1 "C:" pointAtD preInitDone
  pointAtD:
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Recontech Agentic Tool"
  preInitDone:
!macroend
