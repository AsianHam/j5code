/** Leaves headroom under SQLite's bind ceiling for the other fields in a client read. */
const PARTICIPANT_BATCH_SIZE = 900;

export const clientReadBatches = <Value>(values: ReadonlyArray<Value>) => {
  const batches: Array<ReadonlyArray<Value>> = [];
  for (let index = 0; index < values.length; index += PARTICIPANT_BATCH_SIZE) {
    batches.push(values.slice(index, index + PARTICIPANT_BATCH_SIZE));
  }
  return batches;
};
