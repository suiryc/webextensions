package suiryc.webext.native

import io.circe.{Decoder, Encoder}

sealed trait WebExtensionMessage {
  val feature: WebExtensionMessage.Feature.Value
  val kind: WebExtensionMessage.Kind.Value

  val msgCreationTime: Long = System.currentTimeMillis
}

object WebExtensionMessage {

  object FragmentKind extends Enumeration {
    val start: FragmentKind.Value = Value
    val cont: FragmentKind.Value = Value
    val end: FragmentKind.Value = Value
  }

  object Feature extends Enumeration {
    val app: Feature.Value = Value
    val test: Feature.Value = Value
    val tiddlywiki: Feature.Value = Value
  }

  object Kind extends Enumeration {
    val test: Kind.Value = Value
    val log: Kind.Value = Value
    val response: Kind.Value = Value
    val save: Kind.Value = Value
  }

  // It is necessary to explicitly declare the Enumeration encoder/decoder so
  // that automatic derivation works on ApplicationMessage.
  implicit val messageFragmentKindDecoder: Decoder[FragmentKind.Value] = Decoder.enumDecoder(FragmentKind)
  implicit val messageFragmentKindEncoder: Encoder[FragmentKind.Value] = Encoder.enumEncoder(FragmentKind)
  implicit val featureDecoder: Decoder[Feature.Value] = Decoder.enumDecoder(Feature)
  implicit val featureEncoder: Encoder[Feature.Value] = Encoder.enumEncoder(Feature)
  implicit val kindDecoder: Decoder[Kind.Value] = Decoder.enumDecoder(Kind)
  implicit val kindEncoder: Encoder[Kind.Value] = Encoder.enumEncoder(Kind)

}

case class ApplicationMessage(
  feature: WebExtensionMessage.Feature.Value,
  kind: WebExtensionMessage.Kind.Value,
  error: Option[String] = None,
  content: Option[String] = None,
  file: Option[String] = None,
  fragment: Option[WebExtensionMessage.FragmentKind.Value] = None,
  correlationId: Option[String] = None
) extends WebExtensionMessage

object LogMessage {

  object Level extends Enumeration {
    val DEBUG: Level.Value = Value
    val INFO: Level.Value = Value
    val NOTICE: Level.Value = Value
    val WARNING: Level.Value = Value
    val ERROR: Level.Value = Value
  }

  implicit val levelEncoder: Encoder[Level.Value] = Encoder.enumEncoder(Level)

}

case class LogMessage(
  feature: WebExtensionMessage.Feature.Value,
  level: LogMessage.Level.Value,
  message: String,
  kind: WebExtensionMessage.Kind.Value = WebExtensionMessage.Kind.log
) extends WebExtensionMessage
