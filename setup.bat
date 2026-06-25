@echo off
setlocal

echo ============================================
echo  Salesforce Claude MCP - Setup
echo ============================================
echo.

:: Check for Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please install Node.js 20 or later from https://nodejs.org
    exit /b 1
)

:: Check Node version (need v20+)
for /f "tokens=1 delims=v" %%a in ('node --version') do set NODE_VER=%%a
for /f "tokens=1 delims=." %%a in ('node --version 2^>nul') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 20 (
    echo ERROR: Node.js 20 or later is required. Found: %NODE_MAJOR%
    echo Please upgrade Node.js from https://nodejs.org
    exit /b 1
)
echo [OK] Node.js found: %NODE_MAJOR%

:: Check for npm
where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm is not found. Please reinstall Node.js.
    exit /b 1
)
echo [OK] npm found.

:: Copy .env.example to .env if .env does not exist
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [OK] Created .env from .env.example
        echo.
        echo IMPORTANT: Open .env and fill in the required values:
        echo   SF_CLIENT_ID    - Your Salesforce Connected App Client ID
        echo   SF_CLIENT_SECRET - Your Salesforce Connected App Client Secret
        echo   EXTERNAL_BASE_URL - Your Azure App Service URL (for OAuth callback)
        echo.
    ) else (
        echo WARNING: .env.example not found. Please create a .env file manually.
    )
) else (
    echo [OK] .env already exists, skipping copy.
)

:: Install dependencies
echo.
echo Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    exit /b 1
)
echo [OK] Dependencies installed.

:: Build TypeScript
echo.
echo Building TypeScript...
call npm run build
if errorlevel 1 (
    echo ERROR: TypeScript build failed. Check the errors above.
    exit /b 1
)
echo [OK] Build complete. Output in .\dist\

echo.
echo ============================================
echo  Setup complete!
echo  Run start.bat to start the server.
echo ============================================

endlocal
