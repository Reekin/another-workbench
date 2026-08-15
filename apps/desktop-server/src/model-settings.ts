import type { WorkbenchSettingsRpc } from "@another-workbench/shared";

type ModelSettings = Pick<
  WorkbenchSettingsRpc,
  | "allowedModelIdsByEngineId"
  | "customModelReasoningOptionIdsByEngineId"
  | "lastExecutionByEngineId"
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

export const cloneLastExecutionByEngineId = (
  value: ModelSettings["lastExecutionByEngineId"]
): ModelSettings["lastExecutionByEngineId"] =>
  cloneRecord(value, (profile) => ({ ...profile }));

export const cloneModelSettings = (settings: ModelSettings): ModelSettings => ({
  allowedModelIdsByEngineId: cloneAllowedModelIdsByEngineId(
    settings.allowedModelIdsByEngineId
  ),
  customModelReasoningOptionIdsByEngineId:
    cloneCustomModelReasoningOptionIdsByEngineId(
      settings.customModelReasoningOptionIdsByEngineId
    ),
  lastExecutionByEngineId: cloneLastExecutionByEngineId(
    settings.lastExecutionByEngineId
  )
});
