export {
  CanaryRouter,
  DEFAULT_CANARY_CONFIG,
  type CanaryRouterConfig,
  type RoutingDecision,
  type RolloutPhase,
} from "./router.js";

export {
  RollbackPolicy,
  DEFAULT_ROLLBACK_CONFIG,
  type RollbackPolicyConfig,
  type ThresholdConfig,
  type MetricSample,
  type RollbackDecision,
} from "./rollback-policy.js";

export {
  CanaryController,
  DEFAULT_CONTROLLER_CONFIG,
  type CanaryControllerConfig,
  type ControllerEvent,
  type ControllerEventType,
  type ControllerEventListener,
} from "./controller.js";
