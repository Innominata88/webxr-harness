import SwiftUI

struct ControlView: View {
    @EnvironmentObject private var coordinator: VisionBenchmarkCoordinator
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) private var dismissImmersiveSpace

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
                    Button("Exit Immersive") {
                        Task {
                            await dismissImmersiveSpace()
                            coordinator.immersiveOpen = false
                        }
                    }
                    .disabled(coordinator.isRunning)
                } else {
                    Button("Enter Immersive") {
                        Task {
                            let result = await openImmersiveSpace(id: "BenchmarkSpace")
                            coordinator.immersiveOpen = result == .opened
                        }
                    }
                }

                Button("Run Selected Plan") {
                    coordinator.startSelectedPlan()
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    !coordinator.rendererReady
                    || coordinator.isRunning
                    || coordinator.nativeHarnessCommit.trimmingCharacters(
                        in: .whitespacesAndNewlines
                    ).isEmpty
                )

                Button("Cancel", role: .destructive) {
                    coordinator.cancel()
                }
                .disabled(!coordinator.isRunning)
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
            Text("Keep the immersive space open and the headset worn for every measured run. The app saves one JSONL file per run in its Documents/AVP Native XR folder. Do not record an Instruments trace during baseline collection.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .frame(minWidth: 650, minHeight: 480)
    }
}
