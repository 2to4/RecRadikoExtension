import SafariServices
import os.log

/// Safari Web Extension のネイティブ側メッセージハンドラ。
///
/// JavaScript 側から `browser.runtime.sendNativeMessage()` で呼び出されると
/// `beginRequest(with:)` が実行される。
/// 現時点では将来のネイティブ連携用プレースホルダー。
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.recradiko.app.extension",
        category: "SafariWebExtensionHandler"
    )

    func beginRequest(with context: NSExtensionContext) {
        let item    = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]

        logger.log("Received message from web extension: \(String(describing: message))")

        // 応答を返す（将来の native messaging 拡張用）
        let response          = NSExtensionItem()
        response.userInfo     = [SFExtensionMessageKey: ["status": "ok", "version": "0.2.0"]]

        context.completeRequest(returningItems: [response])
    }
}
