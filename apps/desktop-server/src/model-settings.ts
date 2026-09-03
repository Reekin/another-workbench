import type { WorkbenchSettingsRpc } from "@another-workbench/shared";

type ModelSettings = Pick<
  WorkbenchSettingsRpc,
  | "allowedModelIdsByEngineId"
  | "customModelReasoningOptionIdsByEngineId"
  | "executionPreferencesByEngineId"
>;

const cloneRecord = <Value>(
  value: Record<string, Value>,
  cloneValue: (entry: Value) => Value
): Record<string, Value> =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])
  );

export const cloneAllowedModelIdsByEngineId = (
  value: ModelSettings["allowedModelIdsByEngineId"]
): ModelSettings["allowedModelIdsByEngineId"] =>
  cloneRecord(value, (modelIds) => [...modelIds]);

export const cloneCustomModelReasoningOptionIdsByEngineId = (
  value: ModelSettings["customModelReasoningOptionIdsByEngineId"]
): ModelSettings["customModelReasoningOptionIdsByEngineId"] =>
  cloneRecord(value, (modelOptions) =>
    cloneRecord(modelOptions, (optionIds) => [...optionIds])
  );

export const cloneExecutionPreferencesByEngineId = (
  value: ModelSettings["executionPreferencesByEngineId"]
): ModelSettings["executionPreferencesByEngineId"] =>
  cloneRecord(value, (engine) => ({
    ...engine,
    modelPreferences: cloneRecord(engine.modelPreferences, (preference) => ({
      ...preference
    }))
  }));

export const cloneModelSettings = (settings: ModelSettings): ModelSettings => ({
  allowedModelIdsByEngineId: cloneAllowedModelIdsByEngineId(
    settings.allowedModelIdsByEngineId
  ),
  customModelReasoningOptionIdsByEngineId:
    cloneCustomModelReasoningOptionIdsByEngineId(
      settings.customModelReasoningOptionIdsByEngineId
    ),
  executionPreferencesByEngineId: cloneExecutionPreferencesByEngineId(
    settings.executionPreferencesByEngineId
  )
});
