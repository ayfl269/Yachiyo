/** 用于区分"未提供参数"和"显式传 null" */
export const NOT_GIVEN: unique symbol = Symbol("NOT_GIVEN");
export type NotGiven = typeof NOT_GIVEN;
