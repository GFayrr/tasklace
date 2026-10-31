; What the installer of Tasklace adds to the one electron-builder writes: a page that asks, before anything is installed,
; whether Tasklace opens .tasklace files and Tasklace links and whether it checks for new versions; the choices are left
; in the registry of the current user, where Tasklace applies them once at its first launch, and the uninstaller removes
; what this page set up for this installation only, keeping the plans and settings of the person.
; A silent installation keeps both choices unless /NOASSOCIATE or /NOUPDATECHECK turns one off.
; Installed over an existing installation, as when the person runs a newer installer by hand, it neither shows the page
; nor writes any choice, so that the choices made since in Tasklace settings stay as they are.

!define TASKLACE_SETUP_KEY "Software\Tasklace\Setup"
!define TASKLACE_PRIVACY_URL "https://github.com/GFayrr/tasklace/blob/main/PRIVACY.md"

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var tasklaceAssociate
  Var tasklaceCheck
  Var tasklaceExisting
  Var tasklaceAssociateBox
  Var tasklaceCheckBox

  !macro customInit
    StrCpy $tasklaceAssociate 1
    StrCpy $tasklaceCheck 1
    StrCpy $tasklaceExisting 0
    ReadRegStr $R2 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${if} $R2 == ""
      ReadRegStr $R2 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${endIf}
    ${if} $R2 != ""
      StrCpy $tasklaceExisting 1
    ${endIf}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/NOASSOCIATE" $R1
    ${ifNot} ${Errors}
      StrCpy $tasklaceAssociate 0
    ${endIf}
    ClearErrors
    ${GetOptions} $R0 "/NOUPDATECHECK" $R1
    ${ifNot} ${Errors}
      StrCpy $tasklaceCheck 0
    ${endIf}
    ClearErrors
  !macroend

  !macro customPageAfterChangeDir
    Page custom tasklaceChoicesShow tasklaceChoicesLeave

    Function tasklaceChoicesShow
      ${if} ${isUpdated}
      ${orIf} $tasklaceExisting == 1
        Abort
      ${endIf}
      !insertmacro MUI_HEADER_TEXT "Before installing" "What Tasklace does on this computer"
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 20u "Tasklace has no account and sends no usage statistics. Your plans stay on your computer and on the computers of the people you share them with."
      Pop $0
      ${NSD_CreateLabel} 0 24u 100% 28u "Once a day, when it starts, Tasklace asks GitHub which version is the latest. GitHub sees the address of your connection and the version you use. You can turn this off below, or later in Tasklace settings."
      Pop $0
      ${NSD_CreateLink} 0 56u 100% 10u "The whole privacy policy: github.com/GFayrr/tasklace/blob/main/PRIVACY.md"
      Pop $0
      ${NSD_OnClick} $0 tasklaceOpenPrivacyPolicy
      ${NSD_CreateCheckbox} 0 74u 100% 12u "Open .tasklace files and Tasklace links with Tasklace"
      Pop $tasklaceAssociateBox
      ${if} $tasklaceAssociate == 1
        ${NSD_Check} $tasklaceAssociateBox
      ${endIf}
      ${NSD_CreateCheckbox} 0 90u 100% 12u "Check for new versions once a day"
      Pop $tasklaceCheckBox
      ${if} $tasklaceCheck == 1
        ${NSD_Check} $tasklaceCheckBox
      ${endIf}
      ${NSD_CreateLabel} 0 110u 100% 20u "The uninstaller removes what this page set up. Your plans and the settings of Tasklace stay on this computer."
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function tasklaceChoicesLeave
      ${NSD_GetState} $tasklaceAssociateBox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $tasklaceAssociate 1
      ${else}
        StrCpy $tasklaceAssociate 0
      ${endIf}
      ${NSD_GetState} $tasklaceCheckBox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $tasklaceCheck 1
      ${else}
        StrCpy $tasklaceCheck 0
      ${endIf}
    FunctionEnd

    Function tasklaceOpenPrivacyPolicy
      Pop $0
      ExecShell "open" "${TASKLACE_PRIVACY_URL}"
    FunctionEnd
  !macroend

  !macro customInstall
    ${if} ${isUpdated}
    ${orIf} $tasklaceExisting == 1
      DetailPrint "Tasklace was already installed: its choices about files and new versions stay as they are."
    ${else}
      WriteRegDWORD HKCU "${TASKLACE_SETUP_KEY}" "Associate" $tasklaceAssociate
      WriteRegDWORD HKCU "${TASKLACE_SETUP_KEY}" "CheckForNewVersions" $tasklaceCheck
    ${endIf}
  !macroend
!endif

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Classes\Tasklace.Project\shell\open\command" ""
    ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
      DeleteRegKey HKCU "Software\Classes\Tasklace.Project"
      DeleteRegKey HKCU "Software\Classes\tasklace"
      ReadRegStr $1 HKCU "Software\Classes\.tasklace" ""
      ${if} $1 == "Tasklace.Project"
        DeleteRegValue HKCU "Software\Classes\.tasklace" ""
        DeleteRegKey /ifempty HKCU "Software\Classes\.tasklace"
      ${endIf}
    ${elseIf} $0 != ""
      DetailPrint "Another copy of Tasklace opens .tasklace files and Tasklace links, so they are left to it."
    ${endIf}
    DeleteRegKey HKCU "${TASKLACE_SETUP_KEY}"
    DeleteRegKey /ifempty HKCU "Software\Tasklace"
  ${endIf}
!macroend
