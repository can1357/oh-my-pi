@echo off
setlocal
cd /d "%~dp0"

where bun >nul 2>&1
if errorlevel 1 (
	echo Bun was not found in PATH. Install Bun and reopen this file.
	set "OMP_INSTALL_EXIT=1"
	goto :finish
)

echo Installing a detached local OMP package from:
echo   %CD%
echo.
call bun run install:local-package %*
set "OMP_INSTALL_EXIT=%ERRORLEVEL%"

:finish
echo.
if "%OMP_INSTALL_EXIT%"=="0" (
	echo OMP local package installation completed successfully.
) else (
	echo OMP local package installation failed with exit code %OMP_INSTALL_EXIT%.
)
echo.
pause
exit /b %OMP_INSTALL_EXIT%
