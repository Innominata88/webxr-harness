// ContentView.swift
// Two run modes:
//   Manifest mode  — load a native plan JSON, run native repetitions
//   Manual mode    — set parameters directly, run one benchmark

import SwiftUI
import MetalKit

struct ContentView: View {
    @StateObject private var runner = BenchmarkRunner()
    @State private var renderer: BenchmarkRenderer?
    @State private var mtkViewRef: MTKView?
    @State private var rowLimit: Int = 0   // 0 = run all rows

    var body: some View {
        VStack(spacing: 0) {
            MetalView(renderer: $renderer, mtkView: $mtkViewRef)
                .frame(minWidth: 800, minHeight: 500)

            Divider()

            controlPanel
                .padding()
                .frame(minHeight: 140)
        }
        .frame(minWidth: 900, minHeight: 680)
    }

    // MARK: - Control panel

    private var controlPanel: some View {
        VStack(alignment: .leading, spacing: 10) {

            // Status + progress
            HStack {
                Text(runner.status)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if runner.isRunning {
                    ProgressView(value: runner.progress)
                        .frame(width: 180)
                }
            }

            Divider()

            HStack(spacing: 16) {

                // Load controls
                VStack(alignment: .leading, spacing: 6) {
                    Button("Load Model…") { loadModel() }
                        .disabled(runner.isRunning)

                    Button("Load Native Plan…") { loadManifest() }
                        .disabled(runner.isRunning)
                }

                Divider().frame(height: 60)

                // Manifest run
                VStack(alignment: .leading, spacing: 4) {
                    Text("Native plan mode")
                        .font(.caption).foregroundColor(.secondary)
                    if let manifest = runner.loadedManifest {
                        let total = manifest.rows.count
                        let running = rowLimit > 0 ? min(rowLimit, total) : total
                        Text("\(running)/\(total) rows · \(manifest.deviceGroup)/\(manifest.cohortGroup)")
                            .font(.caption).foregroundColor(.secondary)
                    }
                    HStack(spacing: 8) {
                        Button("Run Manifest") { startManifestRun() }
                            .disabled(runner.isRunning || renderer == nil || runner.loadedManifest == nil || runner.mesh == nil)
                            .buttonStyle(.borderedProminent)
                        Stepper(
                            rowLimit == 0 ? "All rows" : "\(rowLimit) rows",
                            value: $rowLimit, in: 0 ... (runner.loadedManifest?.rows.count ?? 20)
                        )
                        .frame(width: 140)
                    }
                }

                Divider().frame(height: 60)

                // Manual run
                VStack(alignment: .leading, spacing: 4) {
                    Text("Manual mode  (uses defaults in BenchmarkConfig)")
                        .font(.caption).foregroundColor(.secondary)
                    Button("Run Manual") { startManualRun() }
                        .disabled(runner.isRunning || renderer == nil || runner.mesh == nil)
                }

                Spacer()
            }
        }
    }

    // MARK: - Actions

    private func loadModel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "glb")!]
        panel.title = "Select GLB model"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do { try await runner.loadModel(url: url) }
            catch { runner.status = "Load failed: \(error.localizedDescription)" }
        }
    }

    private func loadManifest() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "json")!]
        panel.title = "Select native benchmark plan"
        panel.directoryURL = nativePlansDirectory()
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try runner.loadManifest(url: url) }
        catch { runner.status = "Manifest load failed: \(error.localizedDescription)" }
    }

    private func startManifestRun() {
        guard let r = renderer, let view = mtkViewRef else { return }
        Task { await runner.runFromManifest(renderer: r, mtkView: view, rowLimit: rowLimit) }
    }

    private func startManualRun() {
        guard let r = renderer, let view = mtkViewRef else { return }
        Task { await runner.runManual(config: BenchmarkConfig(), renderer: r, mtkView: view) }
    }

    /// Opens the file picker at the harness manifests/ folder if it can be found
    /// by walking up from this source file's compile-time path.
    private func nativePlansDirectory() -> URL? {
        let candidates = [
            URL(fileURLWithPath: #file)
                .deletingLastPathComponent()   // NativeBenchmark/
                .deletingLastPathComponent()   // NativeBenchmark.xcodeproj peer
                .deletingLastPathComponent()   // native/
                .appendingPathComponent("plans"),
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Desktop/PhD Research/Performance Study/webxr-harness/native/plans")
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }
}

// MARK: - MetalView

struct MetalView: NSViewRepresentable {
    @Binding var renderer: BenchmarkRenderer?
    @Binding var mtkView: MTKView?

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.device = MTLCreateSystemDefaultDevice()!
        view.colorPixelFormat        = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.clearColor  = MTLClearColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
        view.clearDepth  = 1.0
        view.preferredFramesPerSecond = 0  // native display refresh rate

        let r = BenchmarkRenderer(mtkView: view)
        view.delegate = r
        DispatchQueue.main.async {
            self.renderer = r
            self.mtkView  = view
        }
        return view
    }

    func updateNSView(_ nsView: MTKView, context: Context) {}
}
