function routeUsesNatFromRoutes(routes, instanceId) {
  return routes.some(route => route.DestinationCidrBlock === '0.0.0.0/0' && route.InstanceId === instanceId);
}

function sessionIsActive(state) {
  return !['SUSPENDED', 'TERMINATED'].includes(state);
}

function sessionsAreIdle(states) {
  return states.every(state => !sessionIsActive(state));
}

module.exports = { routeUsesNatFromRoutes, sessionIsActive, sessionsAreIdle };
