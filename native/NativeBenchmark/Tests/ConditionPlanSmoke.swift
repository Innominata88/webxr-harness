import Foundation

@main
struct ConditionPlanSmoke {
    static func main() throws {
        let expected = [
            (2, 1), (4, 3), (16, 5), (16, 4), (1, 1), (1, 3),
            (1, 5), (8, 1), (2, 3), (32, 1), (4, 2), (8, 5),
            (4, 5), (2, 2), (1, 4), (4, 1), (8, 4), (8, 2),
            (16, 1), (2, 5), (32, 2), (16, 2), (8, 3), (1, 2),
            (32, 4), (32, 3), (16, 3), (4, 4), (2, 4), (32, 5),
        ]
        let actual = buildConditionPlan(
            instancesList: [1, 2, 4, 8, 16, 32],
            trialsPerInstance: 5,
            shuffle: true,
            seed: 12345
        )

        guard actual.count == expected.count else {
            throw ConditionPlanError.count
        }
        for (index, condition) in actual.enumerated() {
            guard condition.instances == expected[index].0,
                  condition.trial == expected[index].1,
                  condition.conditionIndex == index
            else {
                throw ConditionPlanError.mismatch(index)
            }
        }
        print("Condition plan smoke passed: Swift order matches JavaScript")
    }
}

enum ConditionPlanError: Error {
    case count
    case mismatch(Int)
}
