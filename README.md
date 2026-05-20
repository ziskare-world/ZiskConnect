# Zisk Connect

Zisk Connect is a private Android SMS bridge with a Node.js dashboard. It lets a signed-in dashboard user pair one or more Android phones, view SMS activity, and send SMS messages through an available connected phone.

> Built for personal and trusted-circle use. SMS permissions are sensitive, and public hosting should always use HTTPS, strong account security, and protected environment variables.

## Highlights

- Native Android app named **Zisk Connect**
- Dark dashboard with pages for Overview, Messages, Devices, Applications, and System
- Per-device QR pairing with unique pairing tokens
- Multi-device support with automatic fallback to another available phone
- MongoDB-backed users, device pairings, applications, and SMS records
- Sign in and sign up flows backed by MongoDB sessions
- Application API keys for external apps and services
- WebSocket bridge for live device status, queue updates, and SMS events
- Android APK download route from the dashboard server
- Local Wi-Fi, USB reverse, and hosted HTTPS deployment support

## Project Structure

```text
Ziskconnect/
  android/        Native Android app
  server/         Node.js dashboard, API, WebSocket bridge, and SDK
  README.md       Project documentation
```

## How It Works

1. Start the Node.js dashboard server.
2. Sign in or create a dashboard account.
3. Open the Devices page and click **Add Device**.
4. Scan the QR code from the Android app.
5. The phone connects to the dashboard and becomes available for SMS sending.
6. Dashboard or external API requests are queued and assigned to an available connected phone.

Each Android phone receives its own pairing token. If a device is removed, its old token is revoked and it must be added again with a new QR code.

## Requirements

- Node.js 22 or newer
- MongoDB Atlas or local MongoDB
- Android Studio or Android Gradle wrapper
- Android phone with SMS permissions granted

## Server Setup

```powershell
cd server
npm install
npm start
```

By default, the server listens on:

```text
http://127.0.0.1:3001
```

### Environment Variables

Create `server/.env` and configure:

```env
PORT=3001
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=zisk_connect
SESSION_SECRET=change-this-secret
```

For MongoDB Atlas, use your Atlas connection string for `MONGODB_URI`.

## Android Setup

Build the debug APK:

```powershell
cd android
.\gradlew.bat assembleDebug
```

Install on a connected Android phone:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r "D:\Ziskconnect\android\app\build\outputs\apk\debug\app-debug.apk"
```

For USB local development, run:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:3001 tcp:3001
```

Then scan an Add Device QR from the dashboard.

## Dashboard Pages

- **Overview**: Send SMS, view quick stats, recent logs, and queue preview.
- **Messages**: Search, filter, export, and clear SMS logs.
- **Devices**: Add Android phones, view device status, SIM details, and remove devices.
- **Applications**: Create API keys and view sample integration code.
- **System**: View server health, host details, user code, APK download, and security notes.

## External API Example

```js
import { ZiskConnectClient } from './zisk-connect-client.js';

const zisk = new ZiskConnectClient({
  baseUrl: 'https://your-server-url',
  apiKey: 'YOUR_API_KEY',
  userCode: 'YOUR_USER_CODE'
});

const result = await zisk.sendSms({
  address: '9876543210',
  body: 'Hello from Zisk Connect'
});

console.log(result);
```

## Hosting Notes

Recommended free or low-cost hosting:

- Render
- Koyeb
- Railway
- Fly.io

Netlify is not recommended for the backend because Zisk Connect needs a persistent Node.js server and WebSocket connections.

When hosting publicly:

- Use HTTPS
- Keep `.env` values private
- Restrict MongoDB network access
- Use strong passwords
- Share access only with trusted users

## Important Limitations

- Flash/Class-0 SMS is not reliably supported through Android public SDK APIs and may be reported as unsupported.
- SMS permissions are sensitive and this app is intended for private APK use, not normal Play Store distribution.
- Delivery callbacks depend on Android version, device behavior, SIM/carrier support, and network conditions.

## License

Private project. Add a license before public distribution.
