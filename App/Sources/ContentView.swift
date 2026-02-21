import SwiftUI
import SafariServices

struct ContentView: View {
    private let extensionBundleId = "com.recradiko.app.extension"

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "radio.fill")
                .font(.system(size: 52))
                .foregroundStyle(.blue)

            Text("RecRadiko")
                .font(.title)
                .fontWeight(.semibold)

            Text("Radikoタイムフリー録音 Safari 拡張機能")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Divider()

            Button {
                SFSafariApplication.showPreferencesForExtension(
                    withIdentifier: extensionBundleId
                ) { error in
                    if let error {
                        print("Safari 設定を開けませんでした: \(error.localizedDescription)")
                    }
                }
            } label: {
                Label("Safari 機能拡張の設定を開く", systemImage: "safari")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(32)
        .frame(minWidth: 320, minHeight: 240)
    }
}
