@echo off
setlocal

echo ============================================
echo  Salesforce Claude MCP - Start Server
echo ============================================
echo.

:: Check that .env exists
if not exist .env (
    echo ERROR: .env file not found.
    echo Run setup.bat first, then configure your .env file.
    exit /b 1
)

:: Check that the dist build exists
if not exist dist\server.js (
    echo ERROR: dist\server.js not found. The project has not been built yet.
    echo Run setup.bat to install dependencies and build the project.
    exit /b 1
)

:: Show active mode
findstr /i "DEV_BYPASS_USER_ID=" .env | findstr /v "^#" | findstr /v "=$" >nul 2>&1
if not errorlevel 1 (
    echo Mode: LOCAL DEVELOPMENT ^(DEV_BYPASS_* headers active^)
) else (
    echo Mode: PRODUCTION ^(Microsoft Entra ID authentication required^)
)

:: Read PORT from .env for the startup message (default 3000)
set PORT=3000
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set PORT=%%b
)

echo Server starting on http://localhost:%PORT%
echo Health check: http://localhost:%PORT%/health
echo Auth status:  http://localhost:%PORT%/auth/status
echo.
echo Press Ctrl+C to stop the server.
echo.

:: Start the server
node --env-file=.env dist/server.js

endlocal
