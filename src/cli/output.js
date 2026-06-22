export function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeDeployment(stream, result) {
  const deployment = result.deployment || {};
  stream.write(`app_id: ${result.app_id || ""}\n`);
  stream.write(`namespace: ${result.namespace || ""}\n`);
  stream.write(`deployment_id: ${deployment.deployment_id || ""}\n`);
  stream.write(`status: ${deployment.status || ""}\n`);
}

export function writeRegistration(stream, result) {
  stream.write(`agent_id: ${result.agent_id || ""}\n`);
  stream.write(`client_id: ${result.client_id || ""}\n`);
  stream.write(`token_endpoint: ${result.token_endpoint || ""}\n`);
  if (Array.isArray(result.approved_scopes)) {
    stream.write(`approved_scopes: ${result.approved_scopes.join(",")}\n`);
  }
}
