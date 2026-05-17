# Zisk Connect Client

Reusable JavaScript client for other projects.

```js
import { ZiskConnectClient } from './zisk-connect-client.js';

const zisk = new ZiskConnectClient({
  baseUrl: 'http://192.168.1.10:3001',
  userCode: 'YOUR_USER_CODE',
  apiKey: 'YOUR_API_KEY'
});

await zisk.sendSms({
  address: '9876543210',
  body: 'Hello from my project'
});

const { logs } = await zisk.getIncomingSms(25);
console.log(logs);
```

Browser usage:

```html
<script src="http://192.168.1.10:3001/zisk-connect-client.js"></script>
<script>
  const zisk = new ZiskConnectClient({
    baseUrl: 'http://192.168.1.10:3001',
    userCode: 'YOUR_USER_CODE',
    apiKey: 'YOUR_API_KEY'
  });
</script>
```
