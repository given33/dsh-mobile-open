# Third-party notices

## Z.AI ZCode

Copyright 2026 Z.AI Co., Ltd. Licensed under Apache-2.0; see [the included license](licenses/ZCode-Apache-2.0.txt).
`lib/zcode-webview.mjs` adapts `packages/web/src/web-remote-control/app/webRemoteControlLifecycle.ts` and
`packages/ui/src/lib/chatSessionScrollMemory.ts` from `zai-org/ZCode` at `fec975905a2abd4c07e35c40d51fa097a2258ec9`.
The port removes TypeScript-specific interfaces and uses DSH's direct transport and per-document session IDs.
ZCode's relay, accounts, protocol, and desktop runtime are not used.

## Enc-hanted/zcode-remote

Source and interaction reference for mobile shell controls. Upstream: https://github.com/Enc-hanted/zcode-remote

```text
MIT License

Copyright (c) 2026 Enc-hanted

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness theme

Theme tokens used in the iOS client. Upstream package: @deepseek-ai/dsh-client-ui-theme 0.2.2-rc.5.

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The desktop host serves the installed Harness frontend at runtime. That frontend, plugin bundles installed by other vendors, and model services are not included in this source distribution.
