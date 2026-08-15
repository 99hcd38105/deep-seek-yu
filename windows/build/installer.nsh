!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var DesktopShortcutCheckbox
Var AutoStartCheckbox
Var DesktopShortcutOption
Var AutoStartOption

!macro customInit
  StrCpy $DesktopShortcutOption ${BST_CHECKED}
  StrCpy $AutoStartOption ${BST_UNCHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom InstallOptionsPageCreate InstallOptionsPageLeave
!macroend

Function InstallOptionsPageCreate
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装选项"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:选择是否创建快捷方式并随 Windows 启动。"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "请选择 DeepSeek Harness 的安装选项："
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 14u "创建桌面快捷方式（推荐）"
  Pop $DesktopShortcutCheckbox
  ${NSD_SetState} $DesktopShortcutCheckbox $DesktopShortcutOption

  ${NSD_CreateCheckbox} 0 62u 100% 14u "开机时自动启动 DeepSeek Harness"
  Pop $AutoStartCheckbox
  ${NSD_SetState} $AutoStartCheckbox $AutoStartOption

  ${NSD_CreateLabel} 0 92u 100% 34u "开机自启动只为当前 Windows 用户设置，之后可以在任务管理器的“启动应用”中关闭。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function InstallOptionsPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutOption
  ${NSD_GetState} $AutoStartCheckbox $AutoStartOption
FunctionEnd

!macro customInstall
  ${If} $DesktopShortcutOption == ${BST_CHECKED}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${Else}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}

  ${If} $AutoStartOption == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '$\"$appExe$\" --autostart'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend
!endif

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  WinShell::UninstShortcut "$oldDesktopLink"
  Delete "$oldDesktopLink"
!macroend
