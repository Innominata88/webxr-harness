import SwiftUI

struct ControlView: View {
    @EnvironmentObject private var coordinator: VisionBenchmarkCoordinator
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("AVP Native Material Benchmark")
                .font(.largeTitle.weight(.semibold))

            Text("Metal + Compositor Services, immersive VR")
                .font(.title3)
                .foregroundStyle(.secondary)

            Picker("Experiment plan", selection: $coordinator.selectedPlan) {
                ForEach(VisionPlanChoice.allCases) { choice in
                    Text(choice.title).tag(choice)
                }
            }
            .pickerStyle(.menu)
            .disabled(coordinator.isRunning)

            Text(coordinator.planSummary)
                .font(.system(.body, design: .monospaced))

            TextField("Native Git commit (for example, abc1234 or abc1234-dirty)", text: $coordinator.nativeHarnessCommit)
                .textFieldStyle(.roundedBorder)
                .disabled(coordinator.isRunning)

            ProgressView(value: coordinator.progress)
            Text(coordinator.status)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 12) {
                if coordinator.immersiveOpen {
                    Button("Exit Debug Immersion") {
                        Task {
                            await dismissImmersiveSpace()
                            coordinator.immersiveDismissed()
                        }
                    }
                    .disabled(coordinator.isRunning)
                } else {
                    Button("Enter Immersive (Debug)") {
                        Task {
                            let result = await openImmersiveSpace(id: "BenchmarkSpace")
                            coordinator.immersiveOpen = result == .opened
                        }
                    }
                    .disabled(coordinator.isRunning)
                }

                if coordinator.isRunning {
                    if coordinator.canContinueCampaign {
                        Button("Continue Next Run") {
                            guard coordinator.prepareNextCampaignRun() else { return }
                            openCampaignImmersion()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    Button("Start Selected Campaign") {
                        guard coordinator.prepareSelectedCampaign() else { return }
                        openCampaignImmersion()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        coordinator.immersiveOpen
                        || coordinator.nativeHarnessCommit.trimmingCharacters(
                            in: .whitespacesAndNewlines
                        ).isEmpty
                    )
                }

                Button("Cancel", role: .destructive) {
                    coordinator.cancel()
                }
                .disabled(!coordinator.isRunning)

                Button("Export First-Eye Render Target") {
                    coordinator.captureRenderPreview()
                }
                .disabled(!coordinator.rendererReady || coordinator.isRunning)
            }

            if let capture = coordinator.latestCaptureURL {
                ShareLink(item: capture) {
                    Label("Share First-Eye PNG", systemImage: "photo")
                }
            }

            if let output = coordinator.latestOutputURL {
                ShareLink(item: output) {
                    Label("Export Latest JSONL", systemImage: "square.and.arrow.up")
                }
            }
            if coordinator.outputURLs.count > 1 {
                ShareLink(items: coordinator.outputURLs) {
                    Label(
                        "Export All \(coordinator.outputURLs.count) JSONL Files",
                        systemImage: "square.and.arrow.up.on.square"
                    )
                }
            }

            Divider()
            Text("Debug immersion keeps this panel visible for visual checks. A measured campaign must start outside immersion; the panel hides during each run, the immersive session closes for every five-minute cooldown, and Continue Next Run opens a fresh session. The app saves one JSONL file per run in its Documents/AVP Native XR folder. Do not record an Instruments trace during baseline collection.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .frame(minWidth: 650, minHeight: 480)
        .onAppear {
            coordinator.installLifecycleActions(
                dismissImmersive: {
                    await dismissImmersiveSpace()
                },
                openControlWindow: {
                    openWindow(id: "ControlWindow")
                }
            )
        }
    }

    private func openCampaignImmersion() {
        Task {
            let result = await openImmersiveSpace(id: "BenchmarkSpace")
            guard result == .opened else {
                coordinator.campaignImmersiveOpenFailed()
                return
            }
            guard await coordinator.campaignImmersiveOpened() else { return }
            dismissWindow(id: "ControlWindow")
        }
    }
}
