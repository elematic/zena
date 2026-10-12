# Vendored `.proto` files

Copies of upstream protobuf schemas, used as generator input and test
fixtures. They are unmodified.

| Directory                                                            | Source                                                                                                                                     | License      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `google/protobuf/`                                                   | [protocolbuffers/protobuf](https://github.com/protocolbuffers/protobuf) `8703b06b039abc8c1f71fbab1ca94a3c93c6460a`, `src/google/protobuf/` | BSD-3-Clause |
| `google/firestore/v1/`, `google/api/`, `google/rpc/`, `google/type/` | [googleapis/googleapis](https://github.com/googleapis/googleapis) `525d4c82dc1dd2fa3884198a8006a7bf5b48ac9d`                               | Apache-2.0   |

Of `google/api/`, only `field_behavior.proto` is here, because `protoc`
needs it to encode the test fixtures. The others the Firestore protos
import (`annotations.proto`, `client.proto`, `routing.proto`) declare
options, and the generator reads options by name without their
declarations.
