#include "core/simple_json.h"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <sstream>

namespace native_benchmark::json {

Value::Value() : storage_(nullptr) {}
Value::Value(bool value) : storage_(value) {}
Value::Value(double value) : storage_(value) {}
Value::Value(std::string value) : storage_(std::move(value)) {}
Value::Value(Array value) : storage_(std::move(value)) {}
Value::Value(Object value) : storage_(std::move(value)) {}

bool Value::isNull() const { return std::holds_alternative<std::nullptr_t>(storage_); }
bool Value::isBool() const { return std::holds_alternative<bool>(storage_); }
bool Value::isNumber() const { return std::holds_alternative<double>(storage_); }
bool Value::isString() const { return std::holds_alternative<std::string>(storage_); }
bool Value::isArray() const { return std::holds_alternative<Array>(storage_); }
bool Value::isObject() const { return std::holds_alternative<Object>(storage_); }

bool Value::asBool() const {
    if (!isBool()) throw Error("expected boolean");
    return std::get<bool>(storage_);
}

double Value::asNumber() const {
    if (!isNumber()) throw Error("expected number");
    return std::get<double>(storage_);
}

const std::string& Value::asString() const {
    if (!isString()) throw Error("expected string");
    return std::get<std::string>(storage_);
}

const Value::Array& Value::asArray() const {
    if (!isArray()) throw Error("expected array");
    return std::get<Array>(storage_);
}

const Value::Object& Value::asObject() const {
    if (!isObject()) throw Error("expected object");
    return std::get<Object>(storage_);
}

const Value& Value::at(std::string_view key) const {
    const auto& object = asObject();
    const auto found = object.find(key);
    if (found == object.end()) {
        throw Error("missing required field `" + std::string(key) + "`");
    }
    return found->second;
}

const Value* Value::find(std::string_view key) const {
    const auto& object = asObject();
    const auto found = object.find(key);
    return found == object.end() ? nullptr : &found->second;
}

namespace {

class Parser {
public:
    explicit Parser(std::string_view source) : source_(source) {}

    Value run() {
        skipWhitespace();
        Value value = parseValue();
        skipWhitespace();
        if (position_ != source_.size()) fail("unexpected trailing content");
        return value;
    }

private:
    Value parseValue() {
        if (position_ >= source_.size()) fail("unexpected end of input");
        switch (source_[position_]) {
            case 'n': consumeLiteral("null"); return Value();
            case 't': consumeLiteral("true"); return Value(true);
            case 'f': consumeLiteral("false"); return Value(false);
            case '"': return Value(parseString());
            case '[': return Value(parseArray());
            case '{': return Value(parseObject());
            default: return Value(parseNumber());
        }
    }

    Value::Array parseArray() {
        expect('[');
        skipWhitespace();
        Value::Array values;
        if (consume(']')) return values;
        while (true) {
            skipWhitespace();
            values.push_back(parseValue());
            skipWhitespace();
            if (consume(']')) return values;
            expect(',');
        }
    }

    Value::Object parseObject() {
        expect('{');
        skipWhitespace();
        Value::Object values;
        if (consume('}')) return values;
        while (true) {
            skipWhitespace();
            if (position_ >= source_.size() || source_[position_] != '"') {
                fail("expected object key");
            }
            std::string key = parseString();
            skipWhitespace();
            expect(':');
            skipWhitespace();
            auto [ignored, inserted] = values.emplace(std::move(key), parseValue());
            (void)ignored;
            if (!inserted) fail("duplicate object key");
            skipWhitespace();
            if (consume('}')) return values;
            expect(',');
        }
    }

    std::string parseString() {
        expect('"');
        std::string output;
        while (position_ < source_.size()) {
            const char current = source_[position_++];
            if (current == '"') return output;
            if (static_cast<unsigned char>(current) < 0x20) {
                fail("unescaped control character in string");
            }
            if (current != '\\') {
                output.push_back(current);
                continue;
            }
            if (position_ >= source_.size()) fail("unfinished string escape");
            switch (source_[position_++]) {
                case '"': output.push_back('"'); break;
                case '\\': output.push_back('\\'); break;
                case '/': output.push_back('/'); break;
                case 'b': output.push_back('\b'); break;
                case 'f': output.push_back('\f'); break;
                case 'n': output.push_back('\n'); break;
                case 'r': output.push_back('\r'); break;
                case 't': output.push_back('\t'); break;
                case 'u': appendUtf8(output, parseCodePoint()); break;
                default: fail("unsupported string escape");
            }
        }
        fail("unterminated string");
    }

    double parseNumber() {
        const std::size_t start = position_;
        if (consume('-') && position_ >= source_.size()) fail("invalid number");
        if (consume('0')) {
            if (position_ < source_.size() && isDigit(source_[position_])) {
                fail("number has a leading zero");
            }
        } else {
            consumeDigits();
        }
        if (consume('.')) consumeDigits();
        if (position_ < source_.size()
            && (source_[position_] == 'e' || source_[position_] == 'E')) {
            ++position_;
            if (position_ < source_.size()
                && (source_[position_] == '+' || source_[position_] == '-')) {
                ++position_;
            }
            consumeDigits();
        }
        if (position_ == start) fail("expected JSON value");

        std::string token(source_.substr(start, position_ - start));
        char* end = nullptr;
        errno = 0;
        const double value = std::strtod(token.c_str(), &end);
        if (errno == ERANGE || end != token.c_str() + token.size() || !std::isfinite(value)) {
            fail("invalid finite number");
        }
        return value;
    }

    void consumeDigits() {
        const std::size_t start = position_;
        while (position_ < source_.size() && isDigit(source_[position_])) ++position_;
        if (position_ == start) fail("expected digit");
    }

    unsigned parseCodePoint() {
        unsigned value = 0;
        for (int i = 0; i < 4; ++i) {
            if (position_ >= source_.size()) fail("unfinished unicode escape");
            const char current = source_[position_++];
            value <<= 4;
            if (current >= '0' && current <= '9') value |= static_cast<unsigned>(current - '0');
            else if (current >= 'a' && current <= 'f') value |= static_cast<unsigned>(current - 'a' + 10);
            else if (current >= 'A' && current <= 'F') value |= static_cast<unsigned>(current - 'A' + 10);
            else fail("invalid unicode escape");
        }
        return value;
    }

    static void appendUtf8(std::string& output, unsigned codePoint) {
        if (codePoint <= 0x7F) {
            output.push_back(static_cast<char>(codePoint));
        } else if (codePoint <= 0x7FF) {
            output.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
            output.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        } else {
            output.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
            output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
            output.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        }
    }

    void consumeLiteral(std::string_view literal) {
        if (source_.substr(position_, literal.size()) != literal) {
            fail("invalid literal");
        }
        position_ += literal.size();
    }

    bool consume(char expected) {
        if (position_ < source_.size() && source_[position_] == expected) {
            ++position_;
            return true;
        }
        return false;
    }

    void expect(char expected) {
        if (!consume(expected)) {
            fail(std::string("expected `") + expected + "`");
        }
    }

    void skipWhitespace() {
        while (position_ < source_.size()) {
            const char value = source_[position_];
            if (value != ' ' && value != '\n' && value != '\r' && value != '\t') return;
            ++position_;
        }
    }

    static bool isDigit(char value) {
        return value >= '0' && value <= '9';
    }

    [[noreturn]] void fail(const std::string& message) const {
        std::ostringstream output;
        output << "JSON parse error at byte " << position_ << ": " << message;
        throw Error(output.str());
    }

    std::string_view source_;
    std::size_t position_ = 0;
};

}  // namespace

Value parse(std::string_view source) {
    return Parser(source).run();
}

}  // namespace native_benchmark::json
