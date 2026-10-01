# GameWall Build Troubleshooting

## Build Error: "HeadlessStream" namespace not found

If you encounter an error like:
```
error CS0246: The type or namespace name 'HeadlessStream' could not be found
```

This is a build cache corruption issue, not a code problem. The code is correct—it uses `MemoryStream`, not `HeadlessStream`.

### Solution: Clean Build

1. **Close Visual Studio** (if you have it open)

2. **Run the clean build script** in your GameWall folder:
   - Double-click: `GameWall - Clean Build.bat`
   - This removes all temporary build files and clears NuGet cache
   - Wait for it to complete (~30 seconds)

3. **Run the normal build script**:
   - Double-click: `GameWall - Click to Run.bat`
   - This will rebuild everything from scratch

4. **If the error persists**:
   - Make sure you have **.NET 8 SDK** installed:
     ```
     dotnet --version
     ```
     Should show something like `8.0.x`
   - If not installed, download it from: https://dotnet.microsoft.com/download/dotnet/8.0

### What the scripts do

- **GameWall - Clean Build.bat**: Deletes all `bin`, `obj`, and `dist` folders, plus clears the NuGet package cache. Run this if the build is broken or you're getting strange compiler errors.

- **GameWall - Click to Run.bat**: Builds a release version and starts GameWall. On first run, generates a 6-digit pairing code to use with the phone app.

### Still having issues?

If the problem persists after a clean build:

1. **Verify .NET SDK**:
   ```
   dotnet --version
   ```

2. **Check internet connection**: The build downloads NuGet packages on first build.

3. **Try building from command line** (shows more detail):
   ```
   dotnet publish GameWallDisplayHost\GameWallDisplayHost.csproj -c Release -r win-x64 --self-contained true
   ```
   Copy any error messages and share them.

4. **Open GitHub issue** with the full error message and these details:
   - Windows version
   - .NET SDK version (`dotnet --version`)
   - Error output from the command line build

## Build Output

- **dist/DisplayHost/**: GameWall laptop app (single .exe file)
- **dist/ControlServer/**: Optional offline remote server (single .exe file)

Both are self-contained and don't require .NET installed to run.
