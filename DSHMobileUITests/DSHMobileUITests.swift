import XCTest

final class DSHMobileUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testOfficialDesktopStalledFirstPaintCanBeRetried() throws {
        let link = try XCTUnwrap(ProcessInfo.processInfo.environment["DSH_UI_LINK"])
        let app = XCUIApplication()
        app.launchEnvironment["DSH_DEMO_LINK"] = link
        app.launchEnvironment["DSH_TEST_HOLD_FIRST_LAUNCH"] = "1"
        app.launch()
        try waitForWebView(in: app)
        let retry = app.buttons["document-reload"]
        XCTAssertTrue(retry.waitForExistence(timeout: 22), "A missing first-paint acknowledgement must not trap the user")
        retry.tap()
        let status = app.buttons["connection-status-pill"]
        expectation(for: NSPredicate(format: "value BEGINSWITH 'doc:2|' AND value CONTAINS 'connected|busy:false'"), evaluatedWith: status)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(retry.waitForNonExistence(timeout: 8))
    }

    @MainActor @discardableResult
    private func waitForWebView(in app: XCUIApplication) throws -> XCUIElement {
        let web = app.webViews["official-web-view"].firstMatch
        if !web.waitForExistence(timeout: 25) {
            let problem = app.descendants(matching: .any)["pairing-error"].firstMatch
            if problem.exists { XCTFail("Pairing failed: \(problem.label)") }
            else { XCTFail("Official DSH WebView should mount after pairing") }
        }
        return web
    }

    /// Optional live probe. The supplied offer must use an intentionally invalid
    /// code, so it can prove the TLS and HTTP path without registering a device.
    @MainActor
    func testPublicAddressReachesPairingServer() throws {
        guard let link = ProcessInfo.processInfo.environment["DSH_UI_LINK_PUBLIC"], !link.isEmpty else {
            throw XCTSkip("No public relay probe configured")
        }
        let app = XCUIApplication()
        app.launch()
        let paste = app.buttons["paste-pairing-link"]
        XCTAssertTrue(paste.waitForExistence(timeout: 10))
        paste.tap()
        let input = app.descendants(matching: .any)["pairing-link-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText(link)
        app.buttons["继续"].tap()
        let connect = app.buttons["confirm-pairing"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        connect.tap()
        let message = app.descendants(matching: .any)["pairing-error"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 25))
        XCTAssertTrue(message.label.contains("配对码无效") || message.label.contains("二维码已过期"),
                      "Expected a rejection from the desktop after TLS: \(message.label)")
    }

    /// Pairs against an isolated real DeepSeek Harness instance running dsh-mobile-link,
    /// verifies the official desktop web UI loads inside WKWebView with pinned TLS,
    /// and verifies the native sidebar drawer toggle and connection menu.
    @MainActor
    func testOfficialDesktopUILoadsAndTogglesSidebarDrawer() throws {
        let link = try XCTUnwrap(ProcessInfo.processInfo.environment["DSH_UI_LINK"], "Start with scripts/test-official-simulator.sh")
        let app = XCUIApplication()
        app.launchEnvironment["DSH_DEMO_LINK"] = link
        app.launchEnvironment["DSH_TEST_EXPIRY"] = "1"
        app.launchEnvironment["DSH_APPEARANCE"] = "light"
        app.launch()

        let webView = try waitForWebView(in: app)

        // Wait for the official DSH frontend inside WKWebView to hydrate (button/textbox/navigation appears).
        let hydrated = NSPredicate { _, _ in
            webView.buttons.count > 0 || webView.textFields.count > 0 || webView.textViews.count > 0 || webView.staticTexts.count > 0
        }
        expectation(for: hydrated, evaluatedWith: webView)
        waitForExpectations(timeout: 25)

        XCTAssertFalse(app.descendants(matching: .any)["connection-error"].firstMatch.exists,
                       "Should load official DSH without connection errors")

        let sidebarToggle = app.buttons["toggle-sidebar"]
        XCTAssertTrue(sidebarToggle.waitForExistence(timeout: 8))
        let status = app.buttons["connection-status-pill"]
        let online = NSPredicate(format: "value CONTAINS 'connected|busy:false' AND NOT (value CONTAINS 'disconnected') AND NOT (value BEGINSWITH 'doc:0')")
        expectation(for: online, evaluatedWith: status); waitForExpectations(timeout: 30)
        let before = try XCTUnwrap(status.value as? String)
        let parts = before.components(separatedBy: "|renew:")
        let expected = parts[0] + "|renew:" + String((Int(parts.last ?? "") ?? 0) + 1)
        XCUIDevice.shared.press(.home); app.activate()
        expectation(for: NSPredicate(format: "value == %@", expected), evaluatedWith: status); waitForExpectations(timeout: 20)
        let toggled = sidebarToggle.value as? String == "展开" ? "收起" : "展开"
        sidebarToggle.tap()
        expectation(for: NSPredicate(format: "value == %@", toggled), evaluatedWith: sidebarToggle); waitForExpectations(timeout: 10)

        // Tap again to close drawer and verify device selection does not disturb the live WebView.
        sidebarToggle.tap()

        let statusPill = app.buttons["connection-status-pill"]
        XCTAssertTrue(statusPill.waitForExistence(timeout: 8))
        statusPill.tap()
        XCTAssertTrue(app.staticTexts["切换设备"].waitForExistence(timeout: 8))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.staticTexts["切换设备"].waitForNonExistence(timeout: 8))

        let menuButton = app.buttons["connection-help"]
        XCTAssertTrue(menuButton.waitForExistence(timeout: 8))
        menuButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["刷新 DSH 页面"].waitForExistence(timeout: 6))
    }
}
